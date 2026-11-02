/**
 * Kimi for Coding usage JSON (`GET <base>/usages`).
 *
 * Wire contract: the top-level `usage` object is the plan allowance and
 * `limits[]` carries additional rolling windows as
 * `{ window: { duration, timeUnit }, detail: { limit, used, remaining,
 * resetTime } }`. Fields are numbers or numeric strings. A bucket is dropped
 * when `used`/`remaining` is present but not numeric: used vs remaining is
 * never guessed. Window labels are derived from a stated duration only.
 */

import { arrayValue, decimalValue, objectValue, stringValue } from "../json.ts";
import { isoSeconds } from "../headers.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

const UNIT_MINUTES: Record<string, number> = {
  TIME_UNIT_SECOND: 1 / 60,
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1440,
  TIME_UNIT_WEEK: 10080,
  TIME_UNIT_MONTH: 43200,
};

interface Bucket {
  limit?: number;
  used?: number;
  remaining?: number;
  resetAtSeconds?: number;
}

function readBucket(value: unknown): Bucket | undefined {
  const detail = objectValue(value);
  if (detail === undefined) return undefined;
  const limit = decimalValue(detail.limit);
  const used = decimalValue(detail.used);
  const remaining = decimalValue(detail.remaining);
  // Quota counts cannot be negative: a malformed side is never guessed.
  const limitInvalid = detail.limit !== undefined && (limit === undefined || limit < 0);
  const usedInvalid = detail.used !== undefined && (used === undefined || used < 0);
  const remainingInvalid = detail.remaining !== undefined && (remaining === undefined || remaining < 0);
  if (limitInvalid || usedInvalid || remainingInvalid) return undefined;
  if (limit === undefined && used === undefined && remaining === undefined) return undefined;

  const bucket: Bucket = {};
  if (limit !== undefined && limit > 0) bucket.limit = limit;
  // Derive a missing side only from a valid counterpart plus a valid limit.
  if (used !== undefined) bucket.used = used;
  else if (remaining !== undefined && limit !== undefined) bucket.used = Math.max(0, limit - remaining);
  if (remaining !== undefined) bucket.remaining = remaining;
  else if (used !== undefined && limit !== undefined) bucket.remaining = Math.max(0, limit - used);
  const resetAt = isoSeconds(detail.resetTime);
  if (resetAt !== undefined) bucket.resetAtSeconds = resetAt;
  return Object.keys(bucket).length > 0 ? bucket : undefined;
}

function labelFromWindow(value: unknown, fallback: string): { label: string; durationSeconds?: number } {
  const window = objectValue(value);
  if (window === undefined) return { label: fallback };
  const duration = decimalValue(window.duration);
  const unit = stringValue(window.timeUnit);
  if (duration === undefined || duration <= 0 || unit === undefined) return { label: fallback };
  const factor = UNIT_MINUTES[unit];
  if (factor === undefined) return { label: fallback };
  const seconds = Math.round(duration * factor * 60);
  if (!Number.isFinite(seconds) || seconds <= 0) return { label: fallback };
  if (seconds % 86400 === 0) return { label: `${seconds / 86400}d window`, durationSeconds: seconds };
  if (seconds % 3600 === 0) return { label: `${seconds / 3600}h window`, durationSeconds: seconds };
  if (seconds % 60 === 0) return { label: `${seconds / 60}m window`, durationSeconds: seconds };
  return { label: `${seconds}s window`, durationSeconds: seconds };
}

function metricFromBucket(
  id: string,
  label: string,
  bucket: Bucket,
  notices: string[],
  durationSeconds?: number,
): UsageMetric {
  const metric: UsageMetric = {
    id: `kimi.${id}`,
    kind: "subscription-window",
    label,
    scope: "plan",
    source: "kimi-json",
  };
  if (bucket.limit !== undefined) metric.limit = bucket.limit;
  if (bucket.used !== undefined) metric.used = bucket.used;
  if (bucket.remaining !== undefined) metric.remaining = bucket.remaining;
  if (bucket.limit !== undefined && bucket.used !== undefined && bucket.limit > 0) {
    const usedPercent = (bucket.used / bucket.limit) * 100;
    // Finite operands can still overflow; an infinite percentage is not a measurement.
    if (Number.isFinite(usedPercent)) metric.usedPercent = usedPercent;
    else notices.push(`${label} cannot be expressed as a percentage from finite values`);
  }
  if (durationSeconds !== undefined) metric.durationSeconds = durationSeconds;
  if (bucket.resetAtSeconds !== undefined) metric.resetAtSeconds = bucket.resetAtSeconds;
  return metric;
}

export const kimiJsonParser: UsageParser = {
  id: "kimi-json",
  format: "json",

  detect(input: ParseInput): boolean {
    const root = objectValue(input.json);
    if (root === undefined) return false;
    if (readBucket(root.usage) !== undefined) return true;
    const limits = arrayValue(root.limits);
    if (limits === undefined) return false;
    return limits.some((entry) => {
      const item = objectValue(entry);
      return item !== undefined &&
        (objectValue(item.detail) !== undefined || objectValue(item.window) !== undefined) &&
        readBucket(item.detail ?? item) !== undefined;
    });
  },

  parse(input: ParseInput): ParseResult | undefined {
    const root = objectValue(input.json);
    if (root === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    if (root.usage !== undefined) {
      const bucket = readBucket(root.usage);
      if (bucket !== undefined) metrics.push(metricFromBucket("plan", "plan allowance", bucket, notices));
      else notices.push("plan allowance has no usable quota values");
    }

    for (const [index, entry] of (arrayValue(root.limits) ?? []).entries()) {
      const item = objectValue(entry);
      if (item === undefined) {
        notices.push(`limits[${index}] is not an object`);
        continue;
      }
      const bucket = readBucket(item.detail ?? item);
      if (bucket === undefined) {
        notices.push(`limits[${index}] has no usable quota values`);
        continue;
      }
      const described = labelFromWindow(item.window, `window ${index + 1}`);
      metrics.push(
        metricFromBucket(
          `window${index + 1}`,
          described.label,
          bucket,
          notices,
          described.durationSeconds,
        ),
      );
    }

    if (metrics.length === 0) return undefined;
    return {
      scheme: "kimi-json",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
    };
  },
};
