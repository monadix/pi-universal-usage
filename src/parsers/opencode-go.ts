/**
 * OpenCode Go subscription usage (`GET /zen/go/v1/usage`).
 *
 * Wire contract: `usage.rolling`, `usage.weekly`, and `usage.monthly` are
 * independent meters shaped as `{ status, percent, resetsAt }`. `percent` is
 * the consumed share in percentage units (0...100), so 0.5 means 0.5%, not
 * 50%; it is never inverted into a remaining share. `resetsAt` is ISO-8601,
 * and `status` is `ok` or `rate-limited`. A missing or malformed sibling is
 * omitted instead of becoming a fabricated zero or full window. As elsewhere
 * in this package, a finite percentage above 100 is preserved as
 * over-allocation rather than clamped.
 */

import { decimalValue, objectValue, stringValue } from "../json.ts";
import { isoSeconds } from "../headers.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

const WINDOWS = [
  { key: "rolling", id: "rolling", label: "rolling window" },
  { key: "weekly", id: "weekly", label: "weekly window" },
  { key: "monthly", id: "monthly", label: "monthly window" },
] as const;

function windowMetric(label: string, id: string, value: unknown, notices: string[]): UsageMetric | undefined {
  const window = objectValue(value);
  if (window === undefined) {
    notices.push(`${label} is not an object`);
    return undefined;
  }
  const usedPercent = decimalValue(window.percent);
  if (usedPercent === undefined || usedPercent < 0) {
    notices.push(`${label} reports no usable consumed percentage`);
    return undefined;
  }
  const metric: UsageMetric = {
    id: `opencode-go.${id}`,
    kind: "subscription-window",
    label,
    scope: "plan",
    usedPercent,
    source: "opencode-go-json",
  };
  const resetAt = isoSeconds(window.resetsAt);
  if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
  const status = stringValue(window.status);
  if (status === "rate-limited") {
    // The provider refuses requests for this window until it resets; the
    // reported percentage is still the window's consumption.
    metric.status = "limit-reached";
  } else if (status !== undefined && status !== "ok") {
    notices.push(`${label} reports unrecognized status ${status}`);
  }
  return metric;
}

export const opencodeGoJsonParser: UsageParser = {
  id: "opencode-go-json",
  format: "json",

  detect(input: ParseInput): boolean {
    const usage = objectValue(objectValue(input.json)?.usage);
    if (usage === undefined) return false;
    return WINDOWS.some((entry) => objectValue(usage[entry.key]) !== undefined);
  },

  parse(input: ParseInput): ParseResult | undefined {
    const usage = objectValue(objectValue(input.json)?.usage);
    if (usage === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    for (const entry of WINDOWS) {
      if (usage[entry.key] === undefined) continue;
      const metric = windowMetric(entry.label, entry.id, usage[entry.key], notices);
      if (metric !== undefined) metrics.push(metric);
    }

    if (metrics.length === 0) return undefined;
    return {
      scheme: "opencode-go-json",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
    };
  },
};
