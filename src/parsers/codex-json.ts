/**
 * Codex / WHAM rate-limit JSON (`rate_limit.primary_window`,
 * `rate_limit.secondary_window`, optional `credits`).
 *
 * Wire contract: `used_percent` is a finite, non-negative percentage,
 * `limit_window_seconds` is a window duration in seconds, resets arrive either
 * as Unix seconds (`reset_at`) or as a countdown (`reset_after_seconds`).
 * Proxies may omit the primary window (weekly-only plans) or send `null` for it;
 * that is unknown, not 0%. A compatible proxy that computes percent from an
 * allocation can exceed 100 (CPA shadow mode); that over-allocation is a
 * measurement, so it is preserved rather than clamped or rejected.
 */

import { booleanValue, decimalValue, numberValue, objectValue, stringValue } from "../json.ts";
import { epochSeconds } from "../headers.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

function windowLabel(durationSeconds: number | undefined, fallback: string): string {
  if (durationSeconds === undefined || durationSeconds <= 0) return fallback;
  if (durationSeconds % 86400 === 0) return `${durationSeconds / 86400}d window`;
  if (durationSeconds % 3600 === 0) return `${durationSeconds / 3600}h window`;
  if (durationSeconds % 60 === 0) return `${durationSeconds / 60}m window`;
  return `${durationSeconds}s window`;
}

interface ParsedWindow {
  metric?: UsageMetric;
  notice?: string;
}

function parseWindow(
  id: string,
  fallbackLabel: string,
  value: unknown,
  now: number,
  rateLimitRejected: boolean,
  rateLimitReached: boolean,
): ParsedWindow {
  const window = objectValue(value);
  if (window === undefined) return {};
  const usedPercent = decimalValue(window.used_percent);
  const durationRaw = numberValue(window.limit_window_seconds);
  const durationSeconds = durationRaw !== undefined && durationRaw > 0 ? durationRaw : undefined;
  const resetAt = epochSeconds(window.reset_at);
  const resetAfter = numberValue(window.reset_after_seconds);
  const limitReached = booleanValue(window.limit_reached) === true;
  const allowed = booleanValue(window.allowed);

  if (usedPercent === undefined || usedPercent < 0) {
    return { notice: `${fallbackLabel} reports no usable used_percent` };
  }

  const metric: UsageMetric = {
    id: `codex.${id}`,
    kind: "subscription-window",
    label: windowLabel(durationSeconds, fallbackLabel),
    scope: "plan",
    usedPercent,
    source: "codex-json",
  };
  if (durationSeconds !== undefined) metric.durationSeconds = durationSeconds;
  if (resetAt !== undefined) metric.resetAtSeconds = resetAt;
  else if (resetAfter !== undefined && resetAfter >= 0) metric.resetAtSeconds = Math.round(now / 1000 + resetAfter);
  if (limitReached || (rateLimitReached && usedPercent >= 100)) metric.status = "limit-reached";
  else if (allowed === false || rateLimitRejected) metric.status = "rejected";
  return { metric };
}

function parseCredits(value: unknown): UsageMetric | undefined {
  const credits = objectValue(value);
  if (credits === undefined) return undefined;
  const unlimited = booleanValue(credits.unlimited) === true;
  const balance = decimalValue(credits.balance);
  const hasCredits = booleanValue(credits.has_credits);
  if (unlimited) {
    return { id: "codex.credits", kind: "status", label: "credits", scope: "account", status: "unlimited", source: "codex-json" };
  }
  if (balance !== undefined) {
    return {
      id: "codex.credits",
      kind: "budget",
      label: "credits",
      scope: "account",
      remaining: balance,
      unit: "credits",
      source: "codex-json",
    };
  }
  if (hasCredits === true) {
    return { id: "codex.credits", kind: "status", label: "credits", scope: "account", status: "allowed", source: "codex-json" };
  }
  return undefined;
}

/**
 * CPA reports `quota_mode` next to a Codex-shaped body. Shadow mode means the
 * quota is advisory, so the notice must not imply enforcement.
 */
function quotaModeNotice(value: unknown): string | undefined {
  const mode = stringValue(value);
  if (mode === undefined) return undefined;
  if (mode === "shadow") return "quota_mode=shadow: the proxy reports advisory quotas that are not enforced";
  if (mode === "enforce") return "quota_mode=enforce: the proxy enforces this quota";
  return `quota_mode=${mode}`;
}

export const codexJsonParser: UsageParser = {
  id: "codex-json",
  format: "json",

  detect(input: ParseInput): boolean {
    const root = objectValue(input.json);
    if (root === undefined) return false;
    if (objectValue(root.rate_limit) !== undefined) return true;
    const credits = objectValue(root.credits);
    return credits !== undefined && booleanValue(credits.has_credits) !== undefined;
  },

  parse(input: ParseInput): ParseResult | undefined {
    const root = objectValue(input.json);
    if (root === undefined) return undefined;
    const rateLimit = objectValue(root.rate_limit);
    if (rateLimit === undefined) return undefined;

    const limitReached = booleanValue(rateLimit.limit_reached) === true;
    const rejected = limitReached || booleanValue(rateLimit.allowed) === false;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    // A null or absent primary window is valid (weekly-only responses).
    const primary = parseWindow("primary", "primary window", rateLimit.primary_window, input.now, rejected, limitReached);
    if (primary.metric !== undefined) metrics.push(primary.metric);
    if (primary.notice !== undefined) notices.push(primary.notice);

    const secondary = parseWindow("secondary", "secondary window", rateLimit.secondary_window, input.now, rejected, limitReached);
    if (secondary.metric !== undefined) metrics.push(secondary.metric);
    if (secondary.notice !== undefined) notices.push(secondary.notice);

    const credits = parseCredits(root.credits);
    if (credits !== undefined) metrics.push(credits);

    const modeNotice = quotaModeNotice(root.quota_mode);
    if (modeNotice !== undefined) notices.push(modeNotice);
    const planType = stringValue(root.plan_type);
    if (planType !== undefined && planType !== "unknown") notices.push(`plan=${planType}`);

    if (metrics.length === 0) return undefined;
    return {
      scheme: "codex-json",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
      ...(rejected ? { rateLimited: true } : {}),
    };
  },
};
