/**
 * Public type entry for `pi-universal-usage/api`.
 *
 * Keep this file declaration-only and free of relative `.ts` imports. External
 * TypeScript consumers resolve it with their own NodeNext settings, where
 * `allowImportingTsExtensions` is not enabled.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// Public report vocabulary mirrored from the normalized implementation types.
type SchemeId =
  | "codex-json"
  | "codex-headers"
  | "anthropic-json"
  | "anthropic-headers"
  | "rate-limit-headers"
  | "openrouter-json"
  | "deepseek-balance"
  | "kimi-json"
  | "zai-json"
  | "opencode-go-json";

type MetricKind =
  | "subscription-window"
  | "request-limit"
  | "token-limit"
  | "budget"
  | "balance"
  | "status";

type TargetStatus =
  | "ok"
  | "unknown"
  | "unsupported"
  | "no-credential"
  | "rejected"
  | "rate-limited"
  | "unavailable"
  | "error";

// Normalized global configuration accepted by the client. These mirror the
// implementation's non-public configuration types without importing them.
interface ProviderConfig {
  enabled?: boolean;
  scheme?: SchemeId | "auto";
  path?: string;
  pathMode?: "base" | "origin";
}

interface UsageConfig {
  refreshSeconds: number;
  minRefreshSeconds: number;
  timeoutMs: number;
  maxBodyBytes: number;
  maxDiscoveryRequests: number;
  reportConcurrency: number;
  autoRefresh: boolean;
  warnings: boolean;
  warningThresholds: number[];
  providers: Map<string, ProviderConfig>;
  problems: string[];
}

export type UsageRefresh = "cached" | "if-needed" | "force";

export interface UsageModelSelection {
  provider: string;
  modelId: string;
}

/** Exactly one selection shape; mixed or empty selections are argument errors. */
export type UsageSelection =
  | { active: true; providers?: never; models?: never }
  | { providers: readonly string[]; active?: never; models?: never }
  | { models: readonly UsageModelSelection[]; active?: never; providers?: never };

export interface UsageReadOptions {
  selection?: UsageSelection;
  refresh?: UsageRefresh;
  signal?: AbortSignal;
}

export interface ProviderInfo {
  provider: string;
  enabled: boolean;
  active: boolean;
}

export interface UsageMetricComponent {
  label: string;
  value: number;
}

/** The complete public metric vocabulary; unknown fields are never copied. */
export interface UsageMetric {
  id: string;
  kind: MetricKind;
  label: string;
  scope?: string;
  usedPercent?: number;
  remainingPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string;
  resetAtSeconds?: number;
  durationSeconds?: number;
  status?: "allowed" | "rejected" | "limit-reached" | "unavailable" | "unlimited";
  breakdown?: UsageMetricComponent[];
  source: SchemeId;
}

export interface UsageError {
  code: string;
  message: string;
}

export interface UsageResult {
  provider: string;
  modelId?: string;
  status: TargetStatus | "disabled";
  metrics: UsageMetric[];
  freshness: "fresh" | "stale" | "missing";
  observedAt?: number;
  source?: "http" | "headers";
  cacheHit: boolean;
  nextRetryAt?: number;
  notice?: string;
  error?: UsageError;
}

export interface UsageReport {
  schemaVersion: 1;
  generatedAt: number;
  results: UsageResult[];
  configProblems: string[];
}

export interface UsageClient {
  listProviders(): ProviderInfo[];
  read(options?: UsageReadOptions): Promise<UsageReport>;
  dispose(): void;
}

export interface UsageClientOptions {
  modelRegistry: ModelRegistry;
  /** Synchronous current Pi selection; absent means active reads are invalid. */
  getActiveModel?: () => Model<any> | undefined;
  /** Normalized global configuration. Omitted means load the global file once. */
  config?: UsageConfig;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export declare function createUsageClient(options: UsageClientOptions): UsageClient;

/** Pure, deterministic detailed text for a public report. */
export declare function formatUsageReport(report: UsageReport): string;
