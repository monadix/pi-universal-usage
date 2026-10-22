/**
 * Normalized usage vocabulary shared by parsers, endpoint planning, the monitor,
 * and the Pi-facing report. Values stay `undefined` when the wire response does
 * not state them: unknown is never reported as zero.
 */

export type SchemeId =
  | "codex-json"
  | "codex-headers"
  | "anthropic-json"
  | "anthropic-headers"
  | "rate-limit-headers"
  | "openrouter-json"
  | "deepseek-balance"
  | "kimi-json"
  | "zai-json";

export type MetricKind =
  | "subscription-window"
  | "request-limit"
  | "token-limit"
  | "budget"
  | "balance"
  | "status";

export interface MetricComponent {
  label: string;
  value: number;
}

/**
 * One normalized measurement. Percent fields are percentages (0 = unused,
 * 100 = exhausted) regardless of the wire scale each parser consumes;
 * `unit` names monetary or countable units where the payload states them.
 */
export interface UsageMetric {
  id: string;
  kind: MetricKind;
  label: string;
  /** Which account, key, plan, or model the measurement belongs to. */
  scope?: string;
  usedPercent?: number;
  remainingPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string;
  /** Unix seconds. Values in the past are kept so the report can mark them elapsed. */
  resetAtSeconds?: number;
  /** Declared window length in seconds, when the payload states one. */
  durationSeconds?: number;
  status?: "allowed" | "rejected" | "limit-reached" | "unavailable" | "unlimited";
  breakdown?: MetricComponent[];
  source: SchemeId;
}

export interface ParseInput {
  json?: unknown;
  headers?: Record<string, string>;
  status?: number;
  /** Milliseconds since epoch; reset timestamps are resolved against it. */
  now: number;
}

export interface ParseResult {
  scheme: SchemeId;
  metrics: UsageMetric[];
  notice?: string;
  /** The response itself reported a rate-limit rejection. */
  rateLimited?: boolean;
}

export interface UsageParser {
  id: SchemeId;
  format: "json" | "headers";
  /** Structural signature check: true only when the payload is shaped like this scheme. */
  detect(input: ParseInput): boolean;
  /** Returns undefined when no usable measurement exists; never fabricates values. */
  parse(input: ParseInput): ParseResult | undefined;
}

/** Identity of an effective credential/endpoint pair; contains no secret material. */
export interface TargetIdentity {
  key: string;
  providerId: string;
  modelId: string;
  origin: string;
  basePath: string;
  /** Pi auth source label, e.g. "stored" or "environment". */
  authSource: string;
  isOAuth: boolean;
}

export type TargetStatus =
  | "ok"
  | "unknown"
  | "unsupported"
  | "no-credential"
  | "rejected"
  | "rate-limited"
  | "unavailable"
  | "error";

export interface TargetSnapshot {
  identity: TargetIdentity;
  status: TargetStatus;
  scheme?: SchemeId;
  /** Effective origin and path that produced this snapshot. */
  endpoint?: string;
  metrics: UsageMetric[];
  notice?: string;
  error?: string;
  /** Milliseconds since epoch. */
  fetchedAt: number;
  source: "http" | "headers" | "cache";
  /** Milliseconds since epoch; when set, no new attempt starts before it. */
  nextRetryAt?: number;
}
