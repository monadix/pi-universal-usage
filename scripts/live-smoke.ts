/**
 * Opt-in live smoke test. Never runs under `npm test`.
 *
 * It loads the installed Pi runtime through the public SDK service factory, so
 * the configured settings, credentials, models, and extension-registered
 * providers (for example `cpa`) are the same ones Pi uses. No session starts
 * and no inference runs: the script only performs the bound GET quota requests
 * through the extension's own monitor, then prints a sanitized summary
 * (provider id, status, scheme, endpoint path, metric kinds/scalars). It never
 * prints credentials, account ids, model ids, raw payloads, or full origins.
 *
 * Usage:
 *   npm run live-smoke
 *   npm run live-smoke -- --provider deepseek
 *   npm run live-smoke -- --provider openai --provider cpa --json
 *
 * Exit codes: 0 when every requested provider reported a usable snapshot;
 * 1 when a requested provider is not registered, cannot be resolved, or fails.
 */

import { loadConfig } from "../src/config.ts";
import { resolveTarget } from "../src/auth.ts";
import { UsageMonitor } from "../src/monitor.ts";
import { plainText } from "../src/text.ts";
import type { TargetSnapshot } from "../src/types.ts";
import { loadPiModule, locatePiPackage } from "./pi-module.ts";
import { assessLoaderHealth, loaderFailureSummary } from "./smoke-health.ts";

interface Options {
  providers: string[];
  json: boolean;
}

const DEFAULT_PROVIDERS = ["openai", "deepseek", "cpa"];

function parseArgs(argv: readonly string[]): Options {
  const providers: string[] = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--provider") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--provider needs a provider id");
      providers.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      providers.push(arg.slice("--provider=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: live-smoke [--provider <id>]... [--json]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { providers: providers.length > 0 ? providers : [...DEFAULT_PROVIDERS], json };
}

interface ProviderReport {
  provider: string;
  outcome: "ok" | "failed";
  status?: string;
  scheme?: string;
  endpointPath?: string;
  source?: string;
  metrics?: Array<{ kind: string; unit?: string; usedPercent?: number; remaining?: number; limit?: number; reset: boolean }>;
  detail?: string;
}

function sanitizePath(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  try {
    return plainText(new URL(endpoint).pathname);
  } catch {
    return undefined;
  }
}

function metricSummary(snapshot: TargetSnapshot): ProviderReport["metrics"] {
  return snapshot.metrics.map((metric) => ({
    kind: metric.kind,
    ...(metric.unit !== undefined ? { unit: plainText(metric.unit) } : {}),
    ...(metric.usedPercent !== undefined ? { usedPercent: Math.round(metric.usedPercent * 100) / 100 } : {}),
    ...(metric.remaining !== undefined ? { remaining: metric.remaining } : {}),
    ...(metric.limit !== undefined ? { limit: metric.limit } : {}),
    reset: metric.resetAtSeconds !== undefined,
  }));
}

const options = parseArgs(process.argv.slice(2));
const located = locatePiPackage();
if (located === undefined) {
  console.error("live-smoke: could not locate the installed Pi package (set PI_UNIVERSAL_USAGE_PI_PACKAGE)");
  process.exit(1);
}

const pi = await loadPiModule();
// The SDK service factory is what the CLI uses: settings, auth.json/models.json,
// installed packages, and configured extension paths, without creating a
// session. Extension factories register providers during this step.
const services = await pi.createAgentSessionServices({ cwd: process.cwd() });
const loaderHealth = assessLoaderHealth(
  services.diagnostics,
  services.resourceLoader.getExtensions().errors,
);
if (!loaderHealth.ok) {
  console.error(`live-smoke: ${loaderFailureSummary(loaderHealth)}`);
  process.exit(1);
}
const registry = new pi.ModelRegistry(services.modelRuntime);
const settings = services.settingsManager;
const defaultProvider = settings.getDefaultProvider();
const defaultModelId = settings.getDefaultModel();
const config = loadConfig();
const monitor = new UsageMonitor();
const reports: ProviderReport[] = [];

for (const provider of options.providers) {
  const available = registry.getAvailable().filter((model) => model.provider === provider);
  const models = available.length > 0 ? available : registry.getAll().filter((model) => model.provider === provider);
  const reportProvider = plainText(provider);
  if (models.length === 0) {
    reports.push({
      provider: reportProvider,
      outcome: "failed",
      detail: "the loaded Pi runtime registers no model for this provider",
    });
    continue;
  }
  // Prefer the configured default model for the default provider; otherwise the
  // first registered model is enough because auth and base URL are
  // provider-scoped, not model-scoped for quota purposes.
  const model =
    (defaultProvider === provider ? models.find((candidate) => candidate.id === defaultModelId) : undefined) ?? models[0];
  const resolution = await resolveTarget(registry, model, { allowInsecureHttp: true });
  if (!resolution.ok) {
    reports.push({ provider: reportProvider, outcome: "failed", status: resolution.status, detail: plainText(resolution.error) });
    continue;
  }
  const snapshot = await monitor.refresh(
    resolution.target,
    config.providers.get(provider),
    config,
    { force: true },
  );
  const report: ProviderReport = {
    provider: reportProvider,
    outcome: snapshot.status === "ok" ? "ok" : "failed",
    status: snapshot.status,
    source: snapshot.source,
    ...(snapshot.scheme !== undefined ? { scheme: snapshot.scheme } : {}),
    ...(sanitizePath(snapshot.endpoint) !== undefined ? { endpointPath: sanitizePath(snapshot.endpoint) as string } : {}),
    ...(snapshot.metrics.length > 0 ? { metrics: metricSummary(snapshot) } : {}),
    ...(snapshot.error !== undefined ? { detail: plainText(snapshot.error) } : {}),
    ...(snapshot.notice !== undefined
      ? { detail: plainText(`${snapshot.error !== undefined ? `${snapshot.error}; ` : ""}${snapshot.notice}`) }
      : {}),
  };
  reports.push(report);
}

monitor.dispose();

const failed = reports.filter((report) => report.outcome === "failed").length;
const ok = reports.filter((report) => report.outcome === "ok").length;
const providerCount = registry.getAll().length;
const exitCode = failed > 0 ? 1 : 0;

if (options.json) {
  console.log(
    JSON.stringify(
      {
        piPackageSource: located.source,
        registeredModels: providerCount,
        configProblems: config.problems.map((problem) => plainText(problem)),
        reports,
        summary: { ok, failed },
      },
      null,
      2,
    ),
  );
} else {
  console.log("pi-universal-usage live smoke (GET-only)");
  console.log(`pi package: ${located.source}`);
  console.log(`registered models: ${providerCount}`);
  if (config.problems.length > 0) console.log(plainText(`config problems: ${config.problems.join("; ")}`));
  for (const report of reports) {
    const details = [
      `status=${report.status ?? "unresolved"}`,
      report.scheme === undefined ? undefined : `scheme=${report.scheme}`,
      report.endpointPath === undefined ? undefined : `path=${report.endpointPath}`,
      `source=${report.source ?? "n/a"}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" ");
    console.log(plainText(`provider ${report.provider}: ${report.outcome} (${details})`));
    for (const metric of report.metrics ?? []) {
      const parts = [
        `kind=${metric.kind}`,
        metric.unit === undefined ? undefined : `unit=${metric.unit}`,
        metric.usedPercent === undefined ? undefined : `used=${metric.usedPercent}%`,
        metric.remaining === undefined ? undefined : `remaining=${metric.remaining}`,
        metric.limit === undefined ? undefined : `limit=${metric.limit}`,
        `reset=${metric.reset ? "yes" : "no"}`,
      ].filter((part): part is string => part !== undefined);
      console.log(plainText(`  metric ${parts.join(" ")}`));
    }
    if (report.detail !== undefined) console.log(plainText(`  detail: ${report.detail}`));
  }
  console.log(`summary: ${ok} ok, ${failed} failed`);
}

process.exit(exitCode);
