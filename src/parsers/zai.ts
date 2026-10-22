/**
 * Z.ai quota-limit JSON (`GET /api/monitor/usage/quota/limit`).
 *
 * Wire contract (as reported by the official Z.ai plugin and independent
 * clients): an envelope `{ code, success, data: { limits: [...] } }` where each
 * entry has `type` (`TOKENS_LIMIT`, `CREDIT_LIMIT`, `TIME_LIMIT`), a `(unit,
 * number)` window pair, `percentage` (consumed percent), `usage` (the limit),
 * `currentValue` (consumed units), optional `remaining`, and `nextResetTime`.
 *
 * The naming is inverted, so `usage` is never reported as consumed. Percent is
 * taken from `percentage`; when it is absent, a percent is derived only from
 * the documented `currentValue`/`usage` pair and the derivation is disclosed.
 * `(unit, number)` pairs are reported verbatim: this package does not map them
 * to invented window names. Reset times are epoch milliseconds, as Z.ai sends
 * them; smaller numbers are treated as malformed instead of reinterpreted.
 */

import { arrayValue, booleanValue, decimalValue, objectValue, stringValue } from "../json.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

const KNOWN_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"]);

function resetAtSeconds(value: unknown): number | undefined {
  // Documented Z.ai contract: epoch milliseconds.
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 1e12 ? Math.round(value / 1000) : undefined;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
  }
  return undefined;
}

/** A finite, non-negative count or consumption value; invalid values stay unknown. */
function nonNegativeValue(value: unknown, label: string, notices: string[]): number | undefined {
  if (value === undefined) return undefined;
  const parsed = decimalValue(value);
  if (parsed === undefined) {
    notices.push(`${label} is not a usable number; ignored`);
    return undefined;
  }
  if (parsed < 0) {
    notices.push(`${label} is negative; ignored`);
    return undefined;
  }
  return parsed;
}

function entryMetric(type: string, entry: Record<string, unknown>): { metric?: UsageMetric; notice?: string } {
  const unit = decimalValue(entry.unit);
  const number = decimalValue(entry.number);
  const pair = unit !== undefined && number !== undefined ? `unit ${unit} × ${number}` : "unknown window";
  const scope = type === "TIME_LIMIT" ? "tools" : "plan";
  const labelBase = type === "CREDIT_LIMIT" ? "credits" : type === "TIME_LIMIT" ? "tool allowance" : "tokens";
  const notices: string[] = [];

  const percentage = nonNegativeValue(entry.percentage, `${labelBase} percentage`, notices);
  const percentagePresent = entry.percentage !== undefined;
  const limit = nonNegativeValue(entry.usage, `${labelBase} usage limit`, notices);
  const consumed = nonNegativeValue(entry.currentValue, `${labelBase} currentValue`, notices);
  const remaining = nonNegativeValue(entry.remaining, `${labelBase} remaining`, notices);

  const metric: UsageMetric = {
    id: `zai.${type}.${pair}`,
    kind: type === "CREDIT_LIMIT" ? "budget" : "subscription-window",
    label: `${labelBase} (${pair})`,
    scope,
    source: "zai-json",
  };

  if (percentage !== undefined) {
    metric.usedPercent = percentage;
  } else if (!percentagePresent && consumed !== undefined && limit !== undefined && limit > 0) {
    const derived = (consumed / limit) * 100;
    if (Number.isFinite(derived)) {
      metric.usedPercent = derived;
      notices.push(`${labelBase} percent derived from currentValue/usage`);
    } else {
      notices.push(`${labelBase} percent cannot be represented from currentValue/usage`);
    }
  }

  if (limit !== undefined) metric.limit = limit;
  if (consumed !== undefined) metric.used = consumed;
  if (remaining !== undefined) metric.remaining = remaining;
  if (type === "CREDIT_LIMIT") metric.unit = "credits";
  const resetAt = resetAtSeconds(entry.nextResetTime);
  if (resetAt !== undefined) metric.resetAtSeconds = resetAt;

  if (
    metric.usedPercent === undefined &&
    metric.limit === undefined &&
    metric.used === undefined &&
    metric.remaining === undefined &&
    metric.resetAtSeconds === undefined
  ) {
    notices.push(`${labelBase} (${pair}) has no usable quota values`);
    return { notice: notices.join("; ") };
  }
  return { metric, ...(notices.length > 0 ? { notice: notices.join("; ") } : {}) };
}

export const zaiJsonParser: UsageParser = {
  id: "zai-json",
  format: "json",

  detect(input: ParseInput): boolean {
    const root = objectValue(input.json);
    if (root === undefined) return false;
    const limits = arrayValue(objectValue(root.data)?.limits);
    if (limits === undefined) return false;
    return limits.some((entry) => {
      const type = stringValue(objectValue(entry)?.type);
      return type !== undefined && KNOWN_TYPES.has(type);
    });
  },

  parse(input: ParseInput): ParseResult | undefined {
    const root = objectValue(input.json);
    if (root === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    // An explicitly failed envelope is not usable success data, even when it
    // carries limits: reporting those limits as a successful snapshot would
    // hide the API error and pass a smoke check. Returning no parse keeps the
    // response from being accepted by any scheme.
    const success = booleanValue(root.success);
    const code = decimalValue(root.code);
    if (success === false || (code !== undefined && code !== 200)) return undefined;

    for (const entry of arrayValue(objectValue(root.data)?.limits) ?? []) {
      const item = objectValue(entry);
      if (item === undefined) {
        notices.push("a quota limit entry is not an object");
        continue;
      }
      const type = stringValue(item.type);
      if (type === undefined || !KNOWN_TYPES.has(type)) {
        notices.push(`quota limit type ${type ?? "(missing)"} is not understood`);
        continue;
      }
      const parsed = entryMetric(type, item);
      if (parsed.metric !== undefined) metrics.push(parsed.metric);
      if (parsed.notice !== undefined) notices.push(parsed.notice);
    }

    if (metrics.length === 0) return undefined;
    return {
      scheme: "zai-json",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
    };
  },
};
