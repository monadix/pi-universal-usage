/**
 * Global configuration for pi-universal-usage.
 *
 * File: `<agent dir>/pi-universal-usage.json`, where the agent dir is Pi's
 * configurable agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`).
 * A project-local file is deliberately not read: project overrides would let a
 * repository redirect credentialed usage requests, so only the user's global
 * configuration is trusted.
 *
 * The file contains no secrets. Every field is optional.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSchemeId } from "./registry.ts";
import type { SchemeId } from "./types.ts";
import { arrayValue, objectValue } from "./json.ts";

export const CONFIG_FILE_NAME = "pi-universal-usage.json";
export const STATUS_KEY = "universal-usage";

export const DEFAULT_REFRESH_SECONDS = 300;
export const DEFAULT_MIN_REFRESH_SECONDS = 60;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_MAX_DISCOVERY_REQUESTS = 4;
export const DEFAULT_REPORT_CONCURRENCY = 3;

/** Node reduces timer delays above this value to 1 ms instead of scheduling them. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_TIMER_DELAY_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000);

export interface ProviderConfig {
  enabled?: boolean;
  /** "auto" (default) parses whatever compatible format the endpoint returns. */
  scheme?: SchemeId | "auto";
  /** Explicit same-origin endpoint path, e.g. "/backend-api/wham/usage". */
  path?: string;
  /** "base" keeps the effective base-path prefix; "origin" starts at the origin root. */
  pathMode?: "base" | "origin";
}

export interface UsageConfig {
  refreshSeconds: number;
  minRefreshSeconds: number;
  timeoutMs: number;
  maxBodyBytes: number;
  maxDiscoveryRequests: number;
  reportConcurrency: number;
  autoRefresh: boolean;
  warnings: boolean;
  warningThresholds: number[];
  providers: Map<string, ProviderConfig>;
  /** Human-readable problems found while reading the configuration file. */
  problems: string[];
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured !== undefined && configured !== "") {
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return configured;
  }
  return join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), CONFIG_FILE_NAME);
}

function positiveNumber(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) return fallback;
  return value;
}

/** A finite value in [minimum, maximum]; an oversized timer value falls back and is reported. */
function boundedTimerValue(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  unit: string,
  problems: string[],
): number {
  const parsed = positiveNumber(value, fallback, minimum);
  if (parsed > maximum) {
    problems.push(`${label} must be at most ${maximum} ${unit} to stay within the Node timer range; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * A configured path must stay a plain path reference on the credential's own
 * origin. Network-path (`//host/...`), backslash, scheme, or userinfo forms
 * would either resolve to a different authority or make URL construction throw.
 */
function isSameOriginPathReference(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || path.includes("://") || path.includes("@")) return false;
  try {
    const probe = new URL(path, "https://path-reference.invalid");
    return probe.origin === "https://path-reference.invalid" && probe.username === "" && probe.password === "";
  } catch {
    return false;
  }
}

function parseProviderConfig(providerId: string, raw: unknown, problems: string[]): ProviderConfig {
  const entry = objectValue(raw);
  if (entry === undefined) {
    problems.push(`providers.${providerId} must be an object; ignored`);
    return {};
  }
  const config: ProviderConfig = {};
  if (typeof entry.enabled === "boolean") config.enabled = entry.enabled;
  if (entry.scheme !== undefined) {
    if (entry.scheme === "auto") {
      config.scheme = "auto";
    } else if (isSchemeId(entry.scheme)) {
      config.scheme = entry.scheme;
    } else {
      problems.push(`providers.${providerId}.scheme "${String(entry.scheme)}" is not a known scheme; using auto`);
      config.scheme = "auto";
    }
  }
  if (entry.path !== undefined) {
    if (typeof entry.path !== "string" || !isSameOriginPathReference(entry.path)) {
      problems.push(`providers.${providerId}.path must be an absolute path such as "/wham/usage" that stays on the provider origin; ignored`);
    } else {
      config.path = entry.path;
    }
  }
  if (entry.pathMode !== undefined) {
    if (entry.pathMode === "base" || entry.pathMode === "origin") config.pathMode = entry.pathMode;
    else problems.push(`providers.${providerId}.pathMode must be "base" or "origin"; using "base"`);
  }
  return config;
}

/** Normalize a parsed configuration object; never throws for bad user input. */
export function normalizeConfig(raw: unknown): UsageConfig {
  const problems: string[] = [];
  const root = objectValue(raw);
  const providers = new Map<string, ProviderConfig>();
  const config: UsageConfig = {
    refreshSeconds: DEFAULT_REFRESH_SECONDS,
    minRefreshSeconds: DEFAULT_MIN_REFRESH_SECONDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxDiscoveryRequests: DEFAULT_MAX_DISCOVERY_REQUESTS,
    reportConcurrency: DEFAULT_REPORT_CONCURRENCY,
    autoRefresh: true,
    warnings: true,
    warningThresholds: [90, 100],
    providers,
    problems,
  };
  if (root === undefined) {
    if (raw !== undefined) problems.push("configuration root must be a JSON object");
    return config;
  }

  config.refreshSeconds = boundedTimerValue(
    root.refreshSeconds,
    DEFAULT_REFRESH_SECONDS,
    30,
    MAX_TIMER_DELAY_SECONDS,
    "refreshSeconds",
    "seconds",
    problems,
  );
  config.minRefreshSeconds = boundedTimerValue(
    root.minRefreshSeconds,
    DEFAULT_MIN_REFRESH_SECONDS,
    10,
    MAX_TIMER_DELAY_SECONDS,
    "minRefreshSeconds",
    "seconds",
    problems,
  );
  config.timeoutMs = boundedTimerValue(
    root.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    500,
    MAX_TIMER_DELAY_MS,
    "timeoutMs",
    "milliseconds",
    problems,
  );
  config.maxBodyBytes = positiveNumber(root.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024);
  config.maxDiscoveryRequests = Math.floor(positiveNumber(root.maxDiscoveryRequests, DEFAULT_MAX_DISCOVERY_REQUESTS, 1));
  if (root.reportConcurrency !== undefined) {
    if (typeof root.reportConcurrency === "number" && Number.isInteger(root.reportConcurrency) && root.reportConcurrency >= 1 && root.reportConcurrency <= 8) {
      config.reportConcurrency = root.reportConcurrency;
    } else {
      problems.push(`reportConcurrency must be an integer from 1 to 8; using ${DEFAULT_REPORT_CONCURRENCY}`);
    }
  }
  if (typeof root.autoRefresh === "boolean") config.autoRefresh = root.autoRefresh;
  if (root.warnings !== undefined) {
    if (typeof root.warnings === "boolean") config.warnings = root.warnings;
    else problems.push("warnings must be a boolean; using true");
  }
  if (root.warningThresholds !== undefined) {
    if (Array.isArray(root.warningThresholds) && root.warningThresholds.length > 0 &&
      root.warningThresholds.every((value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100)) {
      config.warningThresholds = [...new Set(root.warningThresholds as number[])].sort((a, b) => a - b);
    } else {
      problems.push("warningThresholds must be a non-empty array of finite percentages greater than 0 and at most 100; using [90, 100]");
    }
  }

  const providersRaw = objectValue(root.providers);
  if (providersRaw !== undefined) {
    for (const [providerId, entry] of Object.entries(providersRaw)) {
      if (providerId.trim() === "") {
        problems.push("providers contains an empty provider id; ignored");
        continue;
      }
      providers.set(providerId, parseProviderConfig(providerId, entry, problems));
    }
  } else if (arrayValue(root.providers) !== undefined) {
    problems.push("providers must be an object keyed by provider id; ignored");
  }
  return config;
}

/** Read the global configuration file. A missing file is not a problem. */
export function loadConfig(options: { env?: NodeJS.ProcessEnv; readFile?: (path: string) => string } = {}): UsageConfig {
  const path = configPath(options.env);
  let text: string;
  try {
    text = (options.readFile ?? ((file: string) => readFileSync(file, "utf8")))(path);
  } catch {
    return normalizeConfig(undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const config = normalizeConfig(undefined);
    config.problems.push(`${CONFIG_FILE_NAME} is not valid JSON; using defaults`);
    return config;
  }
  const config = normalizeConfig(parsed);
  return config;
}

export function providerConfig(config: UsageConfig, providerId: string): ProviderConfig | undefined {
  return config.providers.get(providerId);
}

/** Providers explicitly disabled, or enabled for the detailed report. */
export function providerEnabled(config: UsageConfig, providerId: string): boolean {
  return providerConfig(config, providerId)?.enabled !== false;
}
