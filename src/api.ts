/**
 * Headless public API for pi-universal-usage.
 *
 * Importing or constructing a client starts no timers, requests, Pi session or
 * output. The caller supplies Pi's model registry; credentials, routing, and
 * endpoint safety remain Pi's and this package's existing responsibilities.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveTarget, type ResolvedTarget, type TargetResolution } from "./auth.ts";
import { loadConfig, providerEnabled, publicConfigProblem, type UsageConfig } from "./config.ts";
import { formatDuration } from "./format.ts";
import { UsageMonitor } from "./monitor.ts";
import { plainText } from "./text.ts";
import type { MetricKind, SchemeId, TargetIdentity, TargetSnapshot, TargetStatus, UsageMetric as NormalizedMetric } from "./types.ts";

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

interface InternalUsageClientOptions extends UsageClientOptions {
  /**
   * Share an existing monitor inside Pi so tools, `/usage`, background reads and
   * passive headers use one account cache. Omitted clients own their monitor.
   */
  monitor?: UsageMonitor;
}

type ParsedSelection =
  | { kind: "active" }
  | { kind: "providers"; ids: string[] }
  | { kind: "models"; models: UsageModelSelection[] };

interface Target {
  provider: string;
  modelId?: string;
  model?: Model<any>;
  disabled: boolean;
}

const REFRESH_MODES: readonly UsageRefresh[] = ["cached", "if-needed", "force"];
const NUMERIC_METRIC_FIELDS = [
  "usedPercent",
  "remainingPercent",
  "used",
  "limit",
  "remaining",
  "resetAtSeconds",
  "durationSeconds",
] as const;
type NumericMetricField = (typeof NUMERIC_METRIC_FIELDS)[number];
const METRIC_STATUSES = new Set(["allowed", "rejected", "limit-reached", "unavailable", "unlimited"]);

const STATUS_MESSAGES: Record<Exclude<TargetStatus, "ok" | "unknown">, string> = {
  unsupported: "no supported quota endpoint is available for this provider",
  "no-credential": "no usable credential was found for this provider",
  rejected: "the provider rejected the credential",
  "rate-limited": "the provider reported a rate limit",
  unavailable: "the usage service is unavailable",
  error: "the usage refresh failed",
};

function disposedError(): Error {
  return new Error("usage client is disposed");
}

function invalidArgument(message: string): Error {
  return new Error(`invalid usage read arguments: ${message}`);
}

/** Caller cancellation has no private abort reason and a stable public name. */
function abortError(): Error {
  const error = new Error("usage read aborted");
  error.name = "AbortError";
  return error;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseSelection(value: unknown): ParsedSelection {
  if (!isObject(value)) throw invalidArgument("selection must be an object");
  const hasActive = Object.hasOwn(value, "active");
  const hasProviders = Object.hasOwn(value, "providers");
  const hasModels = Object.hasOwn(value, "models");
  const shapes = [hasActive, hasProviders, hasModels].filter(Boolean).length;
  if (shapes !== 1) throw invalidArgument("selection must be exactly one of active, providers, or models");

  if (hasActive) {
    if (!exactKeys(value, ["active"]) || value.active !== true) {
      throw invalidArgument("active selection must be { active: true }");
    }
    return { kind: "active" };
  }

  if (hasProviders) {
    if (!exactKeys(value, ["providers"]) || !Array.isArray(value.providers) || value.providers.length === 0) {
      throw invalidArgument("providers selection must be a non-empty array of provider ids");
    }
    const ids: string[] = [];
    for (const id of value.providers) {
      if (typeof id !== "string" || id.trim() === "") throw invalidArgument("provider ids must be non-blank strings");
      if (!ids.includes(id)) ids.push(id);
    }
    return { kind: "providers", ids };
  }

  if (!exactKeys(value, ["models"]) || !Array.isArray(value.models) || value.models.length === 0) {
    throw invalidArgument("models selection must be a non-empty array of provider/model pairs");
  }
  const models: UsageModelSelection[] = [];
  for (const entry of value.models) {
    if (!isObject(entry)) throw invalidArgument("model selections need provider and modelId strings");
    const provider = entry.provider;
    const modelId = entry.modelId;
    if (!exactKeys(entry, ["provider", "modelId"]) || !nonBlankString(provider) || !nonBlankString(modelId)) {
      throw invalidArgument("model selections need non-blank provider and modelId strings");
    }
    const candidate = { provider, modelId };
    if (!models.some((existing) => existing.provider === candidate.provider && existing.modelId === candidate.modelId)) {
      models.push(candidate);
    }
  }
  return { kind: "models", models };
}

function isRefreshMode(value: unknown): value is UsageRefresh {
  return typeof value === "string" && (REFRESH_MODES as readonly string[]).includes(value);
}

function parseReadOptions(options: UsageReadOptions): { selection: ParsedSelection; refresh: UsageRefresh; signal?: AbortSignal } {
  // Validate the untyped view: narrowing the declared parameter through an
  // index-signature predicate would discard the option types.
  const raw: unknown = options;
  if (!isObject(raw)) throw invalidArgument("read options must be an object");
  if (!exactKeys(raw, ["selection", "refresh", "signal"])) {
    throw invalidArgument("read accepts only selection, refresh, and signal");
  }
  const selection = raw.selection === undefined ? { kind: "active" as const } : parseSelection(raw.selection);
  const refresh: unknown = raw.refresh === undefined ? "if-needed" : raw.refresh;
  if (!isRefreshMode(refresh)) throw invalidArgument("refresh must be cached, if-needed, or force");
  const rawSignal = raw.signal;
  if (rawSignal !== undefined && !(rawSignal instanceof AbortSignal)) {
    throw invalidArgument("signal must be an AbortSignal");
  }
  const signal = rawSignal instanceof AbortSignal ? rawSignal : undefined;
  return {
    selection,
    refresh,
    ...(signal !== undefined ? { signal } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Add the credential-free identity fields that must not become public text. */
function addIdentityRedactions(values: Set<string>, identity: TargetIdentity): void {
  const add = (value: string | undefined) => {
    if (value === undefined) return;
    const clean = plainText(value).trim();
    if (clean !== "") values.add(clean);
  };
  add(identity.origin);
  add(identity.key);
}

/**
 * Values a provider echoed back must never turn into public text. The set is
 * derived only from the credential/routing state Pi actually resolved.
 */
function redactionsFor(target: ResolvedTarget): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => {
    if (value === undefined) return;
    const clean = plainText(value).trim();
    if (clean !== "") values.add(clean);
  };
  addIdentityRedactions(values, target.identity);
  add(target.baseUrl.origin);
  add(target.baseUrl.href);
  add(target.baseUrl.host);
  add(target.baseUrl.hostname);
  add(target.accountId);
  for (const value of Object.values(target.originHeaders)) {
    add(value);
    const token = plainText(value).trim().split(/\s+/u).at(-1);
    if (token !== undefined && token.length >= 3) add(token);
  }
  return [...values].filter((value) => value.length >= 3).sort((left, right) => right.length - left.length);
}

function sanitizerFor(redactions: Iterable<string>): (value: string) => string {
  const patterns: RegExp[] = [];
  const seen = new Set<string>();
  for (const redaction of redactions) {
    const clean = plainText(redaction);
    if (clean.length < 3 || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    patterns.push(new RegExp(escapeRegExp(clean), "giu"));
  }
  return (value) => {
    let text = plainText(value);
    for (const pattern of patterns) text = text.replace(pattern, "[redacted]");
    return text;
  };
}

function publicMetric(metric: NormalizedMetric, sanitize: (value: string) => string): UsageMetric {
  const output: UsageMetric = {
    id: sanitize(metric.id) || "metric",
    kind: metric.kind,
    label: sanitize(metric.label),
    source: metric.source,
  };
  if (metric.scope !== undefined) output.scope = sanitize(metric.scope);
  const numericOutput = output as unknown as Record<NumericMetricField, number | undefined>;
  for (const field of NUMERIC_METRIC_FIELDS) {
    const value = metric[field];
    if (value !== undefined && Number.isFinite(value)) numericOutput[field] = value;
  }
  if (metric.unit !== undefined) output.unit = sanitize(metric.unit);
  if (metric.status !== undefined && METRIC_STATUSES.has(metric.status)) output.status = metric.status;
  if (metric.breakdown !== undefined) {
    const breakdown: UsageMetricComponent[] = [];
    for (const component of metric.breakdown) {
      if (component === undefined || typeof component.label !== "string" || !Number.isFinite(component.value)) continue;
      breakdown.push({ label: sanitize(component.label), value: component.value });
    }
    if (breakdown.length > 0) output.breakdown = breakdown;
  }
  return output;
}

function measurementSource(snapshot: TargetSnapshot): "http" | "headers" | undefined {
  return snapshot.source === "http" || snapshot.source === "headers" ? snapshot.source : undefined;
}

function freshEnough(snapshot: TargetSnapshot, now: number, ttlMs: number): boolean {
  return now - snapshot.fetchedAt <= ttlMs;
}

function errorForStatus(status: TargetStatus | "disabled"): UsageError | undefined {
  if (status === "ok" || status === "unknown" || status === "disabled") return undefined;
  return { code: status, message: STATUS_MESSAGES[status] };
}

function resultFromSnapshot(
  target: Target,
  snapshot: TargetSnapshot,
  options: { now: number; ttlMs: number; cacheHit: boolean; sanitize: (value: string) => string },
): UsageResult {
  const source = measurementSource(snapshot);
  const observedAt = source === undefined ? undefined : finite(snapshot.fetchedAt);
  const status = snapshot.status;
  const result: UsageResult = {
    provider: options.sanitize(target.provider),
    ...(target.modelId !== undefined ? { modelId: options.sanitize(target.modelId) } : {}),
    status,
    metrics: snapshot.metrics.map((metric) => publicMetric(metric, options.sanitize)),
    freshness: source === undefined ? "missing" : freshEnough(snapshot, options.now, options.ttlMs) ? "fresh" : "stale",
    cacheHit: options.cacheHit && source !== undefined,
  };
  if (observedAt !== undefined) result.observedAt = observedAt;
  if (source !== undefined) result.source = source;
  const nextRetryAt = finite(snapshot.nextRetryAt);
  if (nextRetryAt !== undefined) result.nextRetryAt = nextRetryAt;
  if (snapshot.notice !== undefined) {
    const notice = options.sanitize(snapshot.notice);
    if (notice !== "") result.notice = notice;
  }
  const error = errorForStatus(status);
  if (error !== undefined) result.error = error;
  return result;
}

function placeholderResult(
  target: Target,
  status: TargetStatus | "disabled",
  options: { sanitize: (value: string) => string; notice?: string; error?: UsageError },
): UsageResult {
  const result: UsageResult = {
    provider: options.sanitize(target.provider),
    ...(target.modelId !== undefined ? { modelId: options.sanitize(target.modelId) } : {}),
    status,
    metrics: [],
    freshness: "missing",
    cacheHit: false,
  };
  if (options.notice !== undefined) result.notice = options.notice;
  if (options.error !== undefined) result.error = options.error;
  return result;
}

function allRegisteredModels(registry: ModelRegistry): Model<any>[] {
  try {
    const models = registry.getAll();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

function sanitizeConfigProblem(problem: string, sanitize: (value: string) => string): string {
  return sanitize(publicConfigProblem(problem));
}

class HeadlessUsageClient implements UsageClient {
  private readonly registry: ModelRegistry;
  private readonly getActiveModel: (() => Model<any> | undefined) | undefined;
  private readonly config: UsageConfig;
  private readonly monitor: UsageMonitor;
  private readonly ownsMonitor: boolean;
  private readonly now: () => number;
  private readonly lifetime = new AbortController();
  private disposed = false;

  constructor(options: InternalUsageClientOptions) {
    this.registry = options.modelRegistry;
    this.getActiveModel = options.getActiveModel;
    this.config = options.config ?? loadConfig();
    this.now = options.now ?? (() => Date.now());
    this.monitor = options.monitor ?? new UsageMonitor({
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.ownsMonitor = options.monitor === undefined;
  }

  listProviders(): ProviderInfo[] {
    if (this.disposed) throw disposedError();
    const active = this.activeModel();
    const models = allRegisteredModels(this.registry);
    const providers = new Set<string>();
    for (const model of models) if (typeof model.provider === "string" && model.provider !== "") providers.add(model.provider);
    for (const provider of this.config.providers.keys()) providers.add(provider);
    if (active !== undefined) providers.add(active.provider);
    return [...providers]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((provider) => ({
        // Runtime registrations and configuration keys are public IDs at this
        // boundary; the raw value stays authoritative for state comparisons.
        provider: plainText(provider),
        enabled: providerEnabled(this.config, provider),
        active: active?.provider === provider,
      }));
  }

  async read(options: UsageReadOptions = {}): Promise<UsageReport> {
    if (this.disposed) throw disposedError();
    const parsed = parseReadOptions(options);
    if (parsed.signal?.aborted === true) throw abortError();
    const targets = this.resolveTargets(parsed.selection);
    const work = this.collect(targets, parsed.refresh, parsed.signal);
    return this.waitForCaller(work, parsed.signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    if (this.ownsMonitor) this.monitor.dispose();
  }

  private activeModel(): Model<any> | undefined {
    try {
      return this.getActiveModel?.();
    } catch {
      return undefined;
    }
  }

  private resolveTargets(selection: ParsedSelection): Target[] {
    if (selection.kind === "active") {
      const model = this.activeModel();
      if (model === undefined) throw invalidArgument("active selection requires a selected model");
      return [{ provider: model.provider, modelId: model.id, model, disabled: !providerEnabled(this.config, model.provider) }];
    }
    const models = allRegisteredModels(this.registry);
    if (selection.kind === "providers") {
      const active = this.activeModel();
      return selection.ids.map((provider) => {
        const model = active?.provider === provider ? active : models.find((candidate) => candidate.provider === provider);
        return {
          provider,
          ...(model !== undefined ? { modelId: model.id, model } : {}),
          disabled: !providerEnabled(this.config, provider),
        };
      });
    }
    return selection.models.map((selectionModel) => {
      const model = models.find((candidate) =>
        candidate.provider === selectionModel.provider && candidate.id === selectionModel.modelId);
      return {
        provider: selectionModel.provider,
        modelId: selectionModel.modelId,
        ...(model !== undefined ? { model } : {}),
        disabled: !providerEnabled(this.config, selectionModel.provider),
      };
    });
  }

  private async collect(targets: Target[], refresh: UsageRefresh, signal: AbortSignal | undefined): Promise<UsageReport> {
    const results: Array<UsageResult | undefined> = new Array(targets.length);
    const redactions = new Set<string>();
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (this.disposed || signal?.aborted === true) return;
        const index = next++;
        if (index >= targets.length) return;
        const target = targets[index]!;
        try {
          results[index] = await this.readTarget(target, refresh, redactions);
        } catch {
          // Provider and resolver failures are per-result data. Never expose an
          // arbitrary exception message.
          const sanitize = sanitizerFor(redactions);
          results[index] = placeholderResult(target, "error", {
            sanitize,
            error: { code: "error", message: STATUS_MESSAGES.error },
          });
        }
      }
    };
    const workers = Math.min(Math.max(1, this.config.reportConcurrency), Math.max(targets.length, 1));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    const sanitizeProblems = sanitizerFor(redactions);
    return {
      schemaVersion: 1,
      generatedAt: this.now(),
      results: targets.map((target, index) => results[index] ?? placeholderResult(target, "unknown", {
        sanitize: sanitizerFor(redactions),
        notice: "usage data is not available",
      })),
      configProblems: this.config.problems.map((problem) => sanitizeConfigProblem(problem, sanitizeProblems)),
    };
  }

  private async readTarget(target: Target, refresh: UsageRefresh, redactions: Set<string>): Promise<UsageResult> {
    const startedAt = this.now();
    if (target.disabled) {
      return placeholderResult(target, "disabled", {
        sanitize: sanitizerFor(redactions),
        notice: "provider is disabled in pi-universal-usage.json",
      });
    }
    if (target.model === undefined) {
      return placeholderResult(target, "unknown", {
        sanitize: sanitizerFor(redactions),
        notice: "no registered model could be resolved for this provider",
      });
    }
    const resolution = await resolveTarget(this.registry, target.model, { allowInsecureHttp: true });
    if (this.disposed) {
      return placeholderResult(target, "unknown", {
        sanitize: sanitizerFor(redactions),
        notice: "usage client is disposed",
      });
    }
    if (!resolution.ok) return this.failureResult(target, resolution, redactions);

    for (const redaction of redactionsFor(resolution.target)) redactions.add(redaction);
    const sanitize = sanitizerFor(redactions);
    const ttlMs = this.config.refreshSeconds * 1000;
    const known = this.monitor.knownSnapshot(resolution.target);
    if (refresh === "cached") {
      if (known === undefined) {
        return placeholderResult(target, "unknown", { sanitize, notice: "no measurement is cached for this selection" });
      }
      return resultFromSnapshot(target, known, {
        now: this.now(),
        ttlMs,
        cacheHit: measurementSource(known) !== undefined,
        sanitize,
      });
    }
    if (refresh === "if-needed" && known !== undefined) {
      const measured = measurementSource(known) !== undefined;
      if (measured && freshEnough(known, this.now(), ttlMs)) {
        return resultFromSnapshot(target, known, { now: this.now(), ttlMs, cacheHit: true, sanitize });
      }
      const retryAt = finite(known.nextRetryAt);
      if (!measured && retryAt !== undefined && retryAt > this.now()) {
        return resultFromSnapshot(target, known, { now: this.now(), ttlMs, cacheHit: false, sanitize });
      }
    }
    if (this.disposed) {
      return placeholderResult(target, "unknown", { sanitize, notice: "usage client is disposed" });
    }
    const provider = this.config.providers.get(resolution.target.identity.providerId);
    const snapshot = await this.monitor.refresh(resolution.target, provider, this.config, {
      force: refresh === "force",
      external: true,
    });
    return resultFromSnapshot(target, snapshot, {
      now: this.now(),
      ttlMs,
      cacheHit: measurementSource(snapshot) !== undefined && snapshot.fetchedAt < startedAt,
      sanitize,
    });
  }

  private failureResult(
    target: Target,
    resolution: Extract<TargetResolution, { ok: false }>,
    redactions: Set<string>,
  ): UsageResult {
    // Resolution failures carry no origin headers, but an internal identity or
    // rejected origin must never become public text.
    addIdentityRedactions(redactions, resolution.identity);
    const sanitize = sanitizerFor(redactions);
    return placeholderResult(target, resolution.status, {
      sanitize,
      error: { code: resolution.status, message: STATUS_MESSAGES[resolution.status] },
    });
  }

  private waitForCaller<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let onAbort: () => void = () => undefined;
      let onDispose: () => void = () => undefined;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        this.lifetime.signal.removeEventListener("abort", onDispose);
      };
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      onAbort = () => finish(() => reject(abortError()));
      onDispose = () => finish(() => reject(disposedError()));
      if (this.disposed) {
        finish(() => reject(disposedError()));
        void work.catch(() => undefined);
        return;
      }
      if (signal?.aborted === true) {
        finish(() => reject(abortError()));
        void work.catch(() => undefined);
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.lifetime.signal.addEventListener("abort", onDispose, { once: true });
      work.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}

export function createUsageClient(options: InternalUsageClientOptions): UsageClient {
  return new HeadlessUsageClient(options);
}

function usageStatusText(status: UsageResult["status"]): string {
  return status === "ok" ? "available"
    : status === "disabled" ? "disabled"
    : status === "unknown" ? "unknown"
    : status === "unsupported" ? "no supported quota endpoint"
    : status === "no-credential" ? "no credential"
    : status === "rejected" ? "credential rejected"
    : status === "rate-limited" ? "rate limited"
    : status === "unavailable" ? "unavailable"
    : "refresh failed";
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function amountText(value: number, unit: string | undefined): string {
  const formatted = trimNumber(value);
  if (unit === "USD") return `$${formatted}`;
  return unit === undefined ? formatted : `${formatted} ${unit}`;
}

/** Detailed metric text that keeps reported values above 100% intact. */
function formatPublicMetric(metric: UsageMetric, now: number): string {
  const parts: string[] = [];
  let hasMeasurement = false;
  if (metric.usedPercent !== undefined) {
    parts.push(`${trimNumber(metric.usedPercent)}%`);
    hasMeasurement = true;
  } else if (metric.remainingPercent !== undefined) {
    parts.push(`${trimNumber(metric.remainingPercent)}% remaining`);
    hasMeasurement = true;
  } else if (metric.limit !== undefined && metric.remaining !== undefined) {
    parts.push(amountText(metric.remaining, metric.unit));
    hasMeasurement = true;
  } else if (metric.used !== undefined && metric.limit !== undefined) {
    parts.push(`${amountText(metric.used, metric.unit)}/${amountText(metric.limit, metric.unit)}`);
    hasMeasurement = true;
  } else if (metric.remaining !== undefined) {
    parts.push(amountText(metric.remaining, metric.unit));
    hasMeasurement = true;
  } else if (metric.used !== undefined) {
    parts.push(amountText(metric.used, metric.unit));
    hasMeasurement = true;
  } else if (metric.limit !== undefined) {
    parts.push(`limit ${amountText(metric.limit, metric.unit)}; usage unknown`);
    hasMeasurement = true;
  }
  if (metric.status !== undefined && (!hasMeasurement || metric.status !== "allowed")) parts.push(metric.status);
  if (metric.resetAtSeconds !== undefined) {
    const remaining = Math.round(metric.resetAtSeconds - now / 1000);
    parts.push(remaining <= 0 ? "reset elapsed" : `resets in ${formatDuration(remaining)}`);
  }
  return plainText(`${metric.label} ${parts.join(", ")}`);
}

/**
 * Pure, deterministic detailed text for a public report. Every displayed value
 * comes from the report itself and from `generatedAt`; unknown or non-whitelisted
 * properties are ignored and all text is made terminal-safe.
 */
export function formatUsageReport(report: UsageReport): string {
  const generatedAt = finite(report?.generatedAt) ?? 0;
  const results = Array.isArray(report?.results) ? report.results : [];
  const lines: string[] = [];
  if (results.length === 0) lines.push("pi-universal-usage: no usage data is available.");
  for (const result of results) {
    const provider = plainText(typeof result.provider === "string" ? result.provider : "(provider)");
    const modelId = typeof result.modelId === "string" ? `/${plainText(result.modelId)}` : "";
    lines.push(`${provider}${modelId}`);
    const freshness = result.freshness === "fresh" || result.freshness === "stale" ? result.freshness : "missing";
    const source = result.source === "http" || result.source === "headers" ? `, source: ${result.source}` : "";
    lines.push(`  state: ${plainText(usageStatusText(result.status))} (${freshness}${source})`);
    const metrics = Array.isArray(result.metrics) ? result.metrics : [];
    for (const metric of metrics) {
      if (!isObject(metric) || typeof metric.label !== "string") continue;
      const scope = typeof metric.scope === "string" && metric.scope !== "" ? ` [${plainText(metric.scope)}]` : "";
      lines.push(`  - ${formatPublicMetric(metric as UsageMetric, generatedAt)}${scope}`);
      if (metric.breakdown !== undefined && Array.isArray(metric.breakdown)) {
        const parts: string[] = [];
        for (const component of metric.breakdown) {
          if (!isObject(component) || typeof component.label !== "string" ||
            typeof component.value !== "number" || !Number.isFinite(component.value)) continue;
          parts.push(`${plainText(component.label)} ${String(component.value)}`);
        }
        if (parts.length > 0) lines.push(`      ${parts.join(", ")}`);
      }
      const usedPercent = finite(metric.usedPercent);
      if (usedPercent !== undefined && usedPercent > 100) lines.push("      note: reported usage is above 100%");
    }
    if (isObject(result.error) && typeof result.error.message === "string") {
      lines.push(`  error: ${plainText(result.error.message)}`);
    } else if (typeof result.notice === "string" && result.notice !== "") {
      lines.push(`  notice: ${plainText(result.notice)}`);
    }
    const retryAt = finite(result.nextRetryAt);
    if (retryAt !== undefined && retryAt > generatedAt) {
      lines.push(`  next attempt: in ${formatDuration((retryAt - generatedAt) / 1000)}`);
    }
  }
  if (Array.isArray(report?.configProblems)) {
    for (const problem of report.configProblems) {
      if (typeof problem === "string") lines.push(`config: ${plainText(problem)}`);
    }
  }
  return lines.map((line) => plainText(line)).join("\n");
}
