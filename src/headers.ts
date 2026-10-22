/** Header lookup and reset-time helpers shared by the header parsers. */

export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

export function hasHeaderPrefix(headers: Record<string, string>, prefix: string): boolean {
  const expected = prefix.toLowerCase();
  return Object.keys(headers).some((name) => name.toLowerCase().startsWith(expected));
}

/** First finite number among the named headers; empty values are skipped. */
export function headerNumber(headers: Record<string, string>, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = getHeader(headers, name);
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function headerBoolean(headers: Record<string, string>, ...names: string[]): boolean | undefined {
  for (const name of names) {
    const raw = getHeader(headers, name);
    if (raw === undefined) continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

/**
 * Retry-After is a delay in seconds or an HTTP date. It describes when to try
 * again; it is never a quota percentage.
 */
export function parseRetryAfterSeconds(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.round((timestamp - nowMs) / 1000));
}

/** Unix seconds from an explicitly epoch-seconds field. Values outside the epoch range are malformed. */
export function epochSeconds(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return undefined;
  if (parsed <= 0 || parsed >= 1e11) return undefined;
  return Math.round(parsed);
}

/** Unix seconds from an ISO-8601 timestamp string. */
export function isoSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
}

/** Seconds from `nowMs` until `resetAtSeconds`; negative values stay negative to mark an elapsed reset. */
export function secondsUntil(resetAtSeconds: number, nowMs: number): number {
  return Math.round(resetAtSeconds - nowMs / 1000);
}

/** Parse a Go/OpenAI style duration such as "6m0s", "1h2m3s", or "20ms" into seconds. */
export function durationSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu;
  let total = 0;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    const factor = match[2] === "ms" ? 0.001 : match[2] === "s" ? 1 : match[2] === "m" ? 60 : match[2] === "h" ? 3600 : 86400;
    const increment = amount * factor;
    if (!Number.isFinite(increment)) return undefined;
    total += increment;
    if (!Number.isFinite(total)) return undefined;
    consumed += match[0].length;
  }
  if (consumed !== trimmed.length || !Number.isFinite(total)) return undefined;
  return Math.round(total);
}
