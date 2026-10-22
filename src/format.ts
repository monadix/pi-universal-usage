/**
 * Compact and detailed rendering of normalized snapshots. Everything here is
 * plain text; no secrets, identifiers, or raw payloads are printed.
 */

import { secondsUntil } from "./headers.ts";
import { plainText } from "./text.ts";
import type { TargetSnapshot, UsageMetric } from "./types.ts";
import type { UsageConfig } from "./config.ts";

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  const clamped = Math.max(0, Math.min(100, value));
  return `${trimNumber(clamped)}%`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return `${abs}s`;
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

/** Public reports show the endpoint path only, never the effective host or query. */
function endpointPath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname;
  } catch {
    return endpoint.startsWith("/") ? endpoint.split(/[?#]/u)[0] ?? "/" : "(endpoint)";
  }
}

function resetText(metric: UsageMetric, now: number): string | undefined {
  if (metric.resetAtSeconds === undefined) return undefined;
  const remaining = secondsUntil(metric.resetAtSeconds, now);
  if (remaining <= 0) return "reset elapsed";
  return `resets in ${formatDuration(remaining)}`;
}

function amountText(value: number, unit: string | undefined): string {
  const formatted = trimNumber(value);
  if (unit === "USD") return `$${formatted}`;
  if (unit === undefined) return formatted;
  if (unit === unit.toUpperCase() && unit.length <= 3) return `${formatted} ${unit}`;
  return `${formatted} ${unit}`;
}

/** A window's numeric measurement and a meaningful state can both be reported. */
function showsStatusWithMeasurement(status: UsageMetric["status"]): boolean {
  return status !== undefined && status !== "allowed";
}

export function formatMetric(metric: UsageMetric, now: number): string {
  const parts: string[] = [];
  let hasMeasurement = false;
  if (metric.usedPercent !== undefined) {
    parts.push(formatPercent(metric.usedPercent));
    hasMeasurement = true;
  } else if (metric.limit !== undefined && metric.remaining !== undefined) {
    parts.push(amountText(metric.remaining, metric.unit));
    hasMeasurement = true;
  } else if (metric.used !== undefined && metric.limit !== undefined) {
    parts.push(`${amountText(metric.used, metric.unit)}/${amountText(metric.limit, metric.unit)}`);
    hasMeasurement = true;
  } else if (metric.remaining !== undefined) {
    parts.push(amountText(metric.remaining, metric.unit));
    hasMeasurement = true;
  } else if (metric.used !== undefined) {
    parts.push(amountText(metric.used, metric.unit));
    hasMeasurement = true;
  }
  if (metric.status !== undefined && (!hasMeasurement || showsStatusWithMeasurement(metric.status))) {
    parts.push(metric.status);
  }
  const reset = resetText(metric, now);
  if (reset !== undefined) parts.push(reset);
  // Labels, scopes, and units can come from a remote quota payload.
  return plainText(`${metric.label} ${parts.join(", ")}`);
}

const CODEX_WEEK_SECONDS = 7 * 86400;

/**
 * Codex names its windows by role, not duration. Only a declared seven-day
 * window is `weekly`; another declared duration is shown as that duration, and
 * an unstated one keeps the neutral role name instead of inventing a week.
 */
function codexSecondaryLabel(metric: UsageMetric): string {
  if (metric.durationSeconds === undefined) return "secondary";
  if (metric.durationSeconds === CODEX_WEEK_SECONDS) return "weekly";
  return formatDuration(metric.durationSeconds);
}

function shortLabel(metric: UsageMetric): string {
  switch (metric.id) {
    case "codex.primary":
      return "primary";
    case "codex.secondary":
      return codexSecondaryLabel(metric);
    case "anthropic.five_hour":
      return "5h";
    case "anthropic.seven_day":
      return "7d";
    case "ratelimit.requests":
      return "req";
    case "ratelimit.tokens":
      return "tok";
    case "ratelimit.policy":
      return "req*";
    case "openrouter.key-budget":
      return "key";
    case "openrouter.key-spend":
      return "spend";
    case "openrouter.account-credits":
      return "credits";
    case "deepseek.availability":
      return "balance";
    default:
      break;
  }
  if (metric.kind === "balance") return metric.unit ?? "balance";
  if (metric.kind === "budget") return metric.label;
  if (metric.id.startsWith("kimi.")) return metric.durationSeconds === undefined ? "plan" : formatDuration(metric.durationSeconds);
  if (metric.id.startsWith("zai.")) return metric.label.replace(/\s*\(.*\)$/u, "");
  if (metric.id.startsWith("anthropic.")) return metric.label.replace(/ window$/u, "");
  return metric.label;
}

function shortMetric(metric: UsageMetric, now: number): string {
  const label = shortLabel(metric);
  let text = label;
  let hasMeasurement = false;
  if (metric.usedPercent !== undefined) {
    text = `${label} ${formatPercent(metric.usedPercent)}`;
    hasMeasurement = true;
  } else if (metric.remaining !== undefined) {
    text = `${label} ${amountText(metric.remaining, metric.unit)}`;
    hasMeasurement = true;
  } else if (metric.used !== undefined) {
    text = `${label} ${amountText(metric.used, metric.unit)}`;
    hasMeasurement = true;
  }
  if (metric.status !== undefined && (!hasMeasurement || showsStatusWithMeasurement(metric.status))) {
    text = `${text} ${metric.status}`;
  }
  // An elapsed window must stay qualified even when a sibling still has a
  // future reset; attach the qualification to that metric's own display.
  if (metric.resetAtSeconds !== undefined && secondsUntil(metric.resetAtSeconds, now) <= 0) {
    text = `${text} reset elapsed`;
  }
  return text;
}

/** The nearest future reset among displayed metrics, if any. */
function compactResetSuffix(metrics: readonly UsageMetric[], now: number): string {
  const upcoming = metrics
    .map((metric) => (metric.resetAtSeconds === undefined ? undefined : secondsUntil(metric.resetAtSeconds, now)))
    .filter((value): value is number => value !== undefined && value > 0)
    .sort((left, right) => left - right)[0];
  return upcoming === undefined ? "" : ` · reset ${formatDuration(upcoming)}`;
}

/** One-line footer text for the active provider. */
export function formatCompact(snapshot: TargetSnapshot, now: number, config: UsageConfig): string {
  const prefix = plainText(snapshot.identity.providerId);
  const ageMs = Math.max(0, now - snapshot.fetchedAt);
  const staleSuffix = ageMs > config.refreshSeconds * 2000 ? " · stale" : "";
  if (snapshot.status !== "ok") {
    const detail = snapshot.status === "unsupported" ? "no quota interface" : snapshot.status;
    return plainText(`${prefix}: ${detail}${staleSuffix}`);
  }
  const metrics = snapshot.metrics.filter((metric) => metric.status !== "unlimited");
  if (metrics.length === 0) return plainText(`${prefix}: no quota data${staleSuffix}`);
  const displayed = metrics.slice(0, 3);
  const parts = displayed.map((metric) => shortMetric(metric, now));
  if (metrics.length > 3) parts.push(`+${metrics.length - 3}`);
  return plainText(`${prefix}: ${parts.join(" · ")}${compactResetSuffix(displayed, now)}${staleSuffix}`);
}

/** Detailed report lines for `/usage`. */
export function formatReport(
  snapshots: readonly TargetSnapshot[],
  config: UsageConfig,
  now: number,
  options: { staleLimitSeconds?: number } = {},
): string[] {
  const lines: string[] = [];
  if (snapshots.length === 0) {
    lines.push("pi-universal-usage: no provider could be resolved.");
    lines.push("Configure providers in pi-universal-usage.json or select a model first.");
  }
  for (const snapshot of snapshots) {
    const identity = snapshot.identity;
    lines.push(`${identity.providerId}/${identity.modelId}`);
    const endpoint = snapshot.endpoint === undefined ? "" : ` via ${endpointPath(snapshot.endpoint)}`;
    const scheme = snapshot.scheme === undefined ? "" : ` [${snapshot.scheme}]`;
    lines.push(`  state: ${snapshot.status}${scheme}${endpoint} (source: ${snapshot.source})`);
    const ageSeconds = Math.max(0, Math.round((now - snapshot.fetchedAt) / 1000));
    const stale = ageSeconds > (options.staleLimitSeconds ?? config.refreshSeconds * 2);
    lines.push(`  age: ${formatDuration(ageSeconds)}${stale ? " (stale)" : ""}`);
    for (const metric of snapshot.metrics) {
      const scope = metric.scope === undefined ? "" : ` [${metric.scope}]`;
      lines.push(`  - ${formatMetric(metric, now)}${scope}`);
      if (metric.breakdown !== undefined) {
        const parts = metric.breakdown.map((part) => `${part.label} ${amountText(part.value, metric.unit)}`);
        lines.push(`      ${parts.join(", ")}`);
      }
      if (metric.usedPercent !== undefined && metric.usedPercent > 100) {
        lines.push("      note: reported usage is above 100%");
      }
    }
    if (snapshot.error !== undefined) lines.push(`  error: ${snapshot.error}`);
    if (snapshot.notice !== undefined) lines.push(`  notice: ${snapshot.notice}`);
    if (snapshot.nextRetryAt !== undefined && snapshot.nextRetryAt > now) {
      lines.push(`  next attempt: in ${formatDuration((snapshot.nextRetryAt - now) / 1000)}`);
    }
  }
  for (const problem of config.problems) lines.push(`config: ${problem}`);
  return lines.map((line) => plainText(line));
}
