/**
 * OpenRouter accounting JSON.
 *
 * `GET /api/v1/key` reports a key-scoped budget: `limit` (nullable cap),
 * `limit_remaining`, `limit_reset` ("daily" | "weekly" | "monthly" | null), and
 * lifetime/daily spend. `GET /api/v1/credits` reports account credits as
 * `total_credits` and `total_usage`. The two scopes stay distinct metrics, a
 * null cap stays an unknown cap, and a working key-budget response never
 * requires the credits response.
 *
 * OpenRouter documents budget resets at 00:00 UTC, with weeks starting Monday.
 */

import { numberValue, objectValue, stringValue } from "../json.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

function periodResetAt(period: string | undefined, nowMs: number): number | undefined {
  if (period === undefined) return undefined;
  const date = new Date(nowMs);
  date.setUTCHours(0, 0, 0, 0);
  if (period === "daily") {
    date.setUTCDate(date.getUTCDate() + 1);
    return Math.round(date.getTime() / 1000);
  }
  if (period === "weekly") {
    // Days until next Monday (UTC), Monday itself resets a full week later.
    const day = date.getUTCDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
    date.setUTCDate(date.getUTCDate() + daysUntilMonday);
    return Math.round(date.getTime() / 1000);
  }
  if (period === "monthly") {
    date.setUTCMonth(date.getUTCMonth() + 1, 1);
    return Math.round(date.getTime() / 1000);
  }
  return undefined;
}

function keyMetrics(data: Record<string, unknown>, now: number): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  const limit = numberValue(data.limit);
  const limitRemaining = numberValue(data.limit_remaining);
  const period = stringValue(data.limit_reset);

  if (limit !== undefined) {
    const metric: UsageMetric = {
      id: "openrouter.key-budget",
      kind: "budget",
      label: period === undefined ? "key budget" : `key budget (${period})`,
      scope: "key",
      limit,
      unit: "USD",
      source: "openrouter-json",
    };
    if (limitRemaining !== undefined) {
      metric.remaining = limitRemaining;
      metric.used = limit - limitRemaining;
    }
    const resetAt = periodResetAt(period, now);
    if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
    metrics.push(metric);
  }

  // Spend without a cap is still useful, and must not look like a budget of 0.
  const dailySpend = numberValue(data.usage_daily);
  const totalSpend = numberValue(data.usage);
  if (limit === undefined && (dailySpend !== undefined || totalSpend !== undefined)) {
    const metric: UsageMetric = {
      id: "openrouter.key-spend",
      kind: "budget",
      label: dailySpend !== undefined ? "key spend (daily)" : "key spend (lifetime)",
      scope: "key",
      unit: "USD",
      source: "openrouter-json",
    };
    if (dailySpend !== undefined) metric.used = dailySpend;
    else if (totalSpend !== undefined) metric.used = totalSpend;
    const resetAt = dailySpend !== undefined ? periodResetAt("daily", now) : undefined;
    if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
    metrics.push(metric);
  }
  return metrics;
}

function creditsMetrics(data: Record<string, unknown>): { metrics: UsageMetric[]; notice?: string } {
  const total = numberValue(data.total_credits);
  const used = numberValue(data.total_usage);
  if (total === undefined && used === undefined) return { metrics: [] };
  const metric: UsageMetric = {
    id: "openrouter.account-credits",
    kind: "balance",
    label: "account credits",
    scope: "account",
    unit: "USD",
    source: "openrouter-json",
  };
  // Purchased minus consumed can legitimately be negative; it is not clamped.
  // Without a usable consumed value, purchased credits are not remaining
  // credits: report them as a known total and leave the balance unknown.
  if (total !== undefined && used !== undefined) {
    metric.remaining = total - used;
    metric.limit = total;
    metric.used = used;
  } else if (total !== undefined) {
    metric.limit = total;
  } else if (used !== undefined) {
    metric.used = used;
  }
  const breakdown = [];
  if (total !== undefined) breakdown.push({ label: "purchased", value: total });
  if (used !== undefined) breakdown.push({ label: "used", value: used });
  if (breakdown.length > 0) metric.breakdown = breakdown;
  const notice =
    total !== undefined && used === undefined
      ? "account credits report total_credits without a usable total_usage; remaining is unknown"
      : undefined;
  return { metrics: [metric], ...(notice !== undefined ? { notice } : {}) };
}

export const openrouterJsonParser: UsageParser = {
  id: "openrouter-json",
  format: "json",

  detect(input: ParseInput): boolean {
    const root = objectValue(input.json);
    if (root === undefined) return false;
    const data = objectValue(root.data);
    if (data === undefined) return false;
    return (
      data.total_credits !== undefined ||
      data.limit_remaining !== undefined ||
      data.limit_reset !== undefined ||
      (data.limit === null && data.usage !== undefined) ||
      (data.usage_daily !== undefined && data.usage !== undefined)
    );
  },

  parse(input: ParseInput): ParseResult | undefined {
    const root = objectValue(input.json);
    if (root === undefined) return undefined;
    const data = objectValue(root.data);
    if (data === undefined) return undefined;
    const credits = creditsMetrics(data);
    const metrics = [...credits.metrics, ...keyMetrics(data, input.now)];
    if (metrics.length === 0) return undefined;
    return {
      scheme: "openrouter-json",
      metrics,
      ...(credits.notice !== undefined ? { notice: credits.notice } : {}),
    };
  },
};
