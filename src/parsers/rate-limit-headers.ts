/**
 * Generic request/token rate-limit response headers.
 *
 * Supported forms, each with explicit units:
 *  - `x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests`
 *    (OpenAI style; the reset value is a Go duration such as "6m0s").
 *  - `x-ratelimit-limit-tokens` / `-remaining-tokens` / `-reset-tokens`
 *    (same units).
 *  - `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`
 *    (IETF draft; reset is delta-seconds for the server's default policy) and
 *    `RateLimit-Policy` ("100;w=60") for the declared limit and window.
 *  - Bare `x-ratelimit-limit` / `-remaining` / `-reset` when no suffixed
 *    request/token headers are present. Its reset is an absolute Unix
 *    timestamp; a value that cannot be one is ignored rather than reinterpreted
 *    as a duration.
 *
 * These are per-request budgets, not subscription windows. `Retry-After` is a
 * retry delay and is never turned into a quota percentage here.
 */

import { decimalValue } from "../json.ts";
import { durationSeconds, epochSeconds, getHeader, headerNumber } from "../headers.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

/** A count domain: finite and non-negative. */
function countValue(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** An absolute Unix timestamp used by the bare family; smaller values are not epochs. */
const MINIMUM_ABSOLUTE_EPOCH_SECONDS = 946_684_800; // 2000-01-01T00:00:00Z

function absoluteEpoch(value: string | undefined): number | undefined {
  const parsed = epochSeconds(value);
  return parsed !== undefined && parsed >= MINIMUM_ABSOLUTE_EPOCH_SECONDS ? parsed : undefined;
}

function buildMetric(options: {
  id: string;
  kind: "request-limit" | "token-limit";
  label: string;
  scope: string;
  limit?: number;
  remaining?: number;
  resetAtSeconds?: number;
  durationSeconds?: number;
}): UsageMetric {
  const metric: UsageMetric = {
    id: options.id,
    kind: options.kind,
    label: options.label,
    scope: options.scope,
    source: "rate-limit-headers",
  };
  if (options.limit !== undefined) metric.limit = options.limit;
  if (options.remaining !== undefined) metric.remaining = options.remaining;
  if (options.limit !== undefined && options.remaining !== undefined && options.limit > 0) {
    metric.used = Math.max(0, options.limit - options.remaining);
    const usedPercent = (metric.used / options.limit) * 100;
    if (Number.isFinite(usedPercent)) metric.usedPercent = usedPercent;
  }
  if (options.resetAtSeconds !== undefined) metric.resetAtSeconds = options.resetAtSeconds;
  if (options.durationSeconds !== undefined) metric.durationSeconds = options.durationSeconds;
  return metric;
}

function resetAtFrom(
  headers: Record<string, string>,
  name: string,
  now: number,
  form: "duration" | "delta-seconds",
): number | undefined {
  const raw = getHeader(headers, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const seconds = form === "duration" ? durationSeconds(raw) : decimalValue(raw);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const resetAt = now / 1000 + seconds;
  return Number.isFinite(resetAt) ? Math.round(resetAt) : undefined;
}

function parsePolicy(value: string | undefined): { limit?: number; windowSeconds?: number } {
  if (value === undefined) return {};
  const first = value.split(",")[0]?.trim() ?? "";
  const [limitPart, ...params] = first.split(";").map((part) => part.trim());
  const limit = decimalValue(limitPart);
  let windowSeconds: number | undefined;
  for (const param of params) {
    const match = /^w=(\d+)$/u.exec(param);
    if (match !== null) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) windowSeconds = parsed;
    }
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  };
}

export const rateLimitHeadersParser: UsageParser = {
  id: "rate-limit-headers",
  format: "headers",

  detect(input: ParseInput): boolean {
    const headers = input.headers;
    if (headers === undefined) return false;
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    return names.some(
      (name) =>
        name === "x-ratelimit-limit-requests" ||
        name === "x-ratelimit-remaining-requests" ||
        name === "x-ratelimit-limit-tokens" ||
        name === "x-ratelimit-remaining-tokens" ||
        name === "x-ratelimit-limit" ||
        name === "x-ratelimit-remaining" ||
        name === "ratelimit-limit" ||
        name === "ratelimit-remaining",
    );
  },

  parse(input: ParseInput): ParseResult | undefined {
    const headers = input.headers;
    if (headers === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    const requestLimit = countValue(headerNumber(headers, "x-ratelimit-limit-requests"));
    const requestRemaining = countValue(headerNumber(headers, "x-ratelimit-remaining-requests"));
    if (requestLimit !== undefined || requestRemaining !== undefined) {
      const resetAt = resetAtFrom(headers, "x-ratelimit-reset-requests", input.now, "duration");
      metrics.push(
        buildMetric({
          id: "ratelimit.requests",
          kind: "request-limit",
          label: "requests",
          scope: "requests",
          ...(requestLimit !== undefined ? { limit: requestLimit } : {}),
          ...(requestRemaining !== undefined ? { remaining: requestRemaining } : {}),
          ...(resetAt !== undefined ? { resetAtSeconds: resetAt } : {}),
        }),
      );
    }

    const tokenLimit = countValue(headerNumber(headers, "x-ratelimit-limit-tokens"));
    const tokenRemaining = countValue(headerNumber(headers, "x-ratelimit-remaining-tokens"));
    if (tokenLimit !== undefined || tokenRemaining !== undefined) {
      const resetAt = resetAtFrom(headers, "x-ratelimit-reset-tokens", input.now, "duration");
      metrics.push(
        buildMetric({
          id: "ratelimit.tokens",
          kind: "token-limit",
          label: "tokens",
          scope: "tokens",
          ...(tokenLimit !== undefined ? { limit: tokenLimit } : {}),
          ...(tokenRemaining !== undefined ? { remaining: tokenRemaining } : {}),
          ...(resetAt !== undefined ? { resetAtSeconds: resetAt } : {}),
        }),
      );
    }

    // Bare x-ratelimit-* family: only when no suffixed dimension described the
    // same response, so the two forms are not counted twice.
    const hasSuffixed =
      requestLimit !== undefined || requestRemaining !== undefined || tokenLimit !== undefined || tokenRemaining !== undefined;
    if (!hasSuffixed) {
      const bareLimit = countValue(headerNumber(headers, "x-ratelimit-limit"));
      const bareRemaining = countValue(headerNumber(headers, "x-ratelimit-remaining"));
      const bareResetRaw = getHeader(headers, "x-ratelimit-reset");
      const bareResetAt = absoluteEpoch(bareResetRaw);
      if (bareResetRaw !== undefined && bareResetRaw.trim() !== "" && bareResetAt === undefined) {
        notices.push("x-ratelimit-reset is not an absolute Unix timestamp; ignored");
      }
      if (bareLimit !== undefined || bareRemaining !== undefined) {
        metrics.push(
          buildMetric({
            id: "ratelimit.bare",
            kind: "request-limit",
            label: "requests (x-ratelimit)",
            scope: "requests:x-ratelimit",
            ...(bareLimit !== undefined ? { limit: bareLimit } : {}),
            ...(bareRemaining !== undefined ? { remaining: bareRemaining } : {}),
            ...(bareResetAt !== undefined ? { resetAtSeconds: bareResetAt } : {}),
          }),
        );
      }
    }

    // IETF form. `RateLimit-Policy` declares the limit/window; the bare limit
    // header is used when the policy header is absent.
    const policy = parsePolicy(getHeader(headers, "ratelimit-policy"));
    const ietfLimit = countValue(headerNumber(headers, "ratelimit-limit")) ?? countValue(policy.limit);
    const ietfRemaining = countValue(headerNumber(headers, "ratelimit-remaining"));
    if (ietfLimit !== undefined || ietfRemaining !== undefined) {
      const resetAt = resetAtFrom(headers, "ratelimit-reset", input.now, "delta-seconds");
      metrics.push(
        buildMetric({
          id: "ratelimit.policy",
          kind: "request-limit",
          label: "requests (default policy)",
          scope: "requests:default",
          ...(ietfLimit !== undefined ? { limit: ietfLimit } : {}),
          ...(ietfRemaining !== undefined ? { remaining: ietfRemaining } : {}),
          ...(resetAt !== undefined ? { resetAtSeconds: resetAt } : {}),
          ...(policy.windowSeconds !== undefined ? { durationSeconds: policy.windowSeconds } : {}),
        }),
      );
    }

    if (metrics.length === 0) return undefined;
    if (getHeader(headers, "ratelimit-policy") !== undefined && policy.limit === undefined) {
      notices.push("RateLimit-Policy did not state a usable limit");
    }
    return {
      scheme: "rate-limit-headers",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
    };
  },
};
