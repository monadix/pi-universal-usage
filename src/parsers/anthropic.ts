/**
 * Anthropic usage JSON (`five_hour`, `seven_day`, and per-model
 * `seven_day_<model>` windows) and the unified Anthropic rate-limit headers.
 *
 * JSON: `utilization` is a 0..100 percentage, `resets_at` is an ISO-8601
 * timestamp. Window names come from the payload keys only; no duration or label
 * is invented for a key that does not state one.
 *
 * Headers: `anthropic-ratelimit-unified-<5h|7d>-utilization` is a 0..1
 * fraction, `-reset` is Unix seconds, and `-status` may be "rejected".
 */

import { numberInRange, objectValue } from "../json.ts";
import { epochSeconds, getHeader, isoSeconds } from "../headers.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

const KNOWN_WINDOWS = [
  { key: "five_hour", label: "5-hour window", durationSeconds: 5 * 3600 },
  { key: "seven_day", label: "7-day window", durationSeconds: 7 * 86400 },
] as const;

function resetSeconds(value: unknown): number | undefined {
  return isoSeconds(value) ?? epochSeconds(value);
}

function jsonWindowMetric(
  id: string,
  label: string,
  value: unknown,
  options: { durationSeconds?: number; scope?: string } = {},
): UsageMetric | undefined {
  const window = objectValue(value);
  if (window === undefined) return undefined;
  // JSON utilization is declared as 0..100; anything outside that domain is a
  // malformed measurement, not a value to clamp into a reassuring 0% or 100%.
  const usedPercent = numberInRange(window.utilization, 0, 100);
  if (usedPercent === undefined) return undefined;
  const metric: UsageMetric = {
    id: `anthropic.${id}`,
    kind: "subscription-window",
    label,
    scope: options.scope ?? "plan",
    usedPercent,
    source: "anthropic-json",
  };
  if (options.durationSeconds !== undefined) metric.durationSeconds = options.durationSeconds;
  const resetAt = resetSeconds(window.resets_at);
  if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
  return metric;
}

function isWindowKey(key: string): boolean {
  return key === "five_hour" || key === "seven_day" || key.startsWith("seven_day_");
}

export const anthropicJsonParser: UsageParser = {
  id: "anthropic-json",
  format: "json",

  detect(input: ParseInput): boolean {
    const root = objectValue(input.json);
    if (root === undefined) return false;
    return Object.keys(root).some((key) => isWindowKey(key) && objectValue(root[key]) !== undefined);
  },

  parse(input: ParseInput): ParseResult | undefined {
    const root = objectValue(input.json);
    if (root === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    for (const known of KNOWN_WINDOWS) {
      if (root[known.key] === undefined) continue;
      const metric = jsonWindowMetric(known.key, known.label, root[known.key], {
        durationSeconds: known.durationSeconds,
      });
      if (metric !== undefined) metrics.push(metric);
      else notices.push(`${known.label} reports no usable utilization`);
    }

    // Per-model windows are identified by the key suffix, e.g. seven_day_opus.
    for (const [key, value] of Object.entries(root)) {
      if (!key.startsWith("seven_day_")) continue;
      const model = key.slice("seven_day_".length);
      if (model === "") continue;
      const metric = jsonWindowMetric(key, `${model} 7-day window`, value, { scope: `model:${model}` });
      if (metric !== undefined) metrics.push(metric);
      else notices.push(`${key} reports no usable utilization`);
    }

    if (metrics.length === 0) return undefined;
    return {
      scheme: "anthropic-json",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
    };
  },
};

export const anthropicHeadersParser: UsageParser = {
  id: "anthropic-headers",
  format: "headers",

  detect(input: ParseInput): boolean {
    const headers = input.headers;
    if (headers === undefined) return false;
    return Object.keys(headers).some((name) => name.toLowerCase().startsWith("anthropic-ratelimit-unified-"));
  },

  parse(input: ParseInput): ParseResult | undefined {
    const headers = input.headers;
    if (headers === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];
    let rejected = false;

    for (const known of [
      { suffix: "5h", label: "5-hour window", durationSeconds: 5 * 3600 },
      { suffix: "7d", label: "7-day window", durationSeconds: 7 * 86400 },
    ]) {
      const utilizationRaw = getHeader(headers, `anthropic-ratelimit-unified-${known.suffix}-utilization`);
      // The unified header contract is a 0..1 fraction; "42" is malformed, not 4200%.
      const utilization = numberInRange(utilizationRaw, 0, 1);
      if (utilizationRaw !== undefined && utilization === undefined) {
        notices.push(`${known.label} reports a utilization outside the documented 0..1 range`);
      }
      const resetAt = epochSeconds(getHeader(headers, `anthropic-ratelimit-unified-${known.suffix}-reset`));
      const status = getHeader(headers, `anthropic-ratelimit-unified-${known.suffix}-status`)?.trim();
      if (utilization === undefined && resetAt === undefined && status === undefined) continue;

      const metric: UsageMetric = {
        id: `anthropic.${known.suffix}`,
        kind: "subscription-window",
        label: known.label,
        scope: "plan",
        durationSeconds: known.durationSeconds,
        source: "anthropic-headers",
      };
      if (utilization !== undefined) {
        // 0..1 fraction -> 0..100 percent, applied exactly once.
        metric.usedPercent = utilization * 100;
      }
      if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
      if (status === "rejected") {
        metric.status = "rejected";
        rejected = true;
      } else if (status === "allowed") {
        metric.status = "allowed";
      }
      metrics.push(metric);
    }

    if (getHeader(headers, "anthropic-ratelimit-unified-status")?.trim() === "rejected") rejected = true;
    if (metrics.length === 0 && !rejected) return undefined;

    return {
      scheme: "anthropic-headers",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
      ...(rejected ? { rateLimited: true } : {}),
    };
  },
};
