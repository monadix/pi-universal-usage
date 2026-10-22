/**
 * Codex response headers (`x-codex-primary-*`, `x-codex-secondary-*`,
 * `x-codex-credits-*`). These appear on inference responses, so they are the
 * passive source when no usage endpoint exists. Percent headers are 0..100,
 * window headers are minutes, and reset headers are Unix seconds or countdowns.
 */

import { decimalValue } from "../json.ts";
import { epochSeconds, getHeader, hasHeaderPrefix, headerBoolean, headerNumber } from "../headers.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

function windowLabel(id: "primary" | "secondary", durationSeconds: number | undefined): string {
  if (durationSeconds === undefined) return id === "primary" ? "primary window" : "secondary window";
  if (durationSeconds % 86400 === 0) return `${durationSeconds / 86400}d window`;
  return `${Math.round(durationSeconds / 3600)}h window`;
}

function windowMetric(
  id: "primary" | "secondary",
  headers: Record<string, string>,
  now: number,
): UsageMetric | undefined {
  const usedPercent = headerNumber(headers, `x-codex-${id}-used-percent`);
  if (usedPercent === undefined || usedPercent < 0) return undefined;

  const minutes = headerNumber(headers, `x-codex-${id}-window-minutes`);
  const seconds = minutes === undefined ? undefined : minutes * 60;
  const durationSeconds = seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined;
  const resetAt = epochSeconds(getHeader(headers, `x-codex-${id}-reset-at`));
  const resetAfter = headerNumber(headers, `x-codex-${id}-reset-after-seconds`);

  const metric: UsageMetric = {
    id: `codex.${id}`,
    kind: "subscription-window",
    label: windowLabel(id, durationSeconds),
    scope: "plan",
    usedPercent,
    source: "codex-headers",
  };
  if (durationSeconds !== undefined) metric.durationSeconds = durationSeconds;
  if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
  else if (resetAfter !== undefined && resetAfter >= 0) metric.resetAtSeconds = Math.round(now / 1000 + resetAfter);
  return metric;
}

export const codexHeadersParser: UsageParser = {
  id: "codex-headers",
  format: "headers",

  detect(input: ParseInput): boolean {
    return input.headers !== undefined && hasHeaderPrefix(input.headers, "x-codex-");
  },

  parse(input: ParseInput): ParseResult | undefined {
    const headers = input.headers;
    if (headers === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const primary = windowMetric("primary", headers, input.now);
    if (primary !== undefined) metrics.push(primary);
    const secondary = windowMetric("secondary", headers, input.now);
    if (secondary !== undefined) metrics.push(secondary);

    const unlimited = headerBoolean(headers, "x-codex-credits-unlimited") === true;
    const hasCredits = headerBoolean(headers, "x-codex-credits-has-credits");
    const balance = decimalValue(getHeader(headers, "x-codex-credits-balance"));
    if (unlimited) {
      metrics.push({ id: "codex.credits", kind: "status", label: "credits", scope: "account", status: "unlimited", source: "codex-headers" });
    } else if (balance !== undefined) {
      metrics.push({
        id: "codex.credits",
        kind: "budget",
        label: "credits",
        scope: "account",
        remaining: balance,
        unit: "credits",
        source: "codex-headers",
      });
    } else if (hasCredits === true) {
      metrics.push({ id: "codex.credits", kind: "status", label: "credits", scope: "account", status: "allowed", source: "codex-headers" });
    }

    // Only plan metadata present: no quota dimension to report.
    if (metrics.length === 0) return undefined;
    return { scheme: "codex-headers", metrics };
  },
};
