/**
 * Refresh orchestration: one bounded GET sequence per effective target, with
 * endpoint caching, negative caching/backoff, duplicate-refresh deduplication,
 * and cancellation. Each target entry owns at most one run, which carries both
 * the promise concurrent refreshes join and the controller that cancels it.
 * Passive header parsing is display-only and never touches the cache. Nothing
 * here writes to a provider or mutates Pi state.
 */

import { planEndpoints, type EndpointPlan, type PlannedRequest } from "./endpoints.ts";
import { httpGet, type HttpPolicy } from "./http.ts";
import { getHeader, parseRetryAfterSeconds } from "./headers.ts";
import { parseHeaderPayload, parseJsonPayload } from "./registry.ts";
import type { ResolvedTarget } from "./auth.ts";
import type { ProviderConfig, UsageConfig } from "./config.ts";
import type { ParseResult, SchemeId, TargetSnapshot, TargetStatus, UsageMetric } from "./types.ts";

const FAILURE_BACKOFF_MS = 60_000;
const AUTH_FAILURE_BACKOFF_MS = 30 * 60_000;
const RATE_LIMIT_DEFAULT_MS = 5 * 60_000;
const UNAVAILABLE_DEFAULT_MS = 5 * 60_000;

export interface MonitorOptions {
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Overrides the configuration's HTTP limits; used by tests. */
  policy?: Partial<HttpPolicy>;
}

interface CachedEndpoint {
  /** URL of the endpoint that produced the last required result; no credentials are stored. */
  url: string;
}

/** An optional endpoint's own retry deadline, honored across refreshes. */
interface OptionalDeferral {
  nextAttemptAt: number;
  reason: "rate-limited" | "unavailable";
}

/**
 * One entry-owned refresh run: the promise concurrent refreshes join and the
 * controller that cancels the request sequence.
 */
interface Run {
  readonly controller: AbortController;
  /**
   * The sequence's result. Assigned in the same synchronous frame that installs
   * the run; the record is installed first, so a path that answers without a
   * network await already owns its entry.
   */
  promise: Promise<TargetSnapshot>;
}

interface Entry {
  snapshot?: TargetSnapshot;
  endpoint?: CachedEndpoint;
  /** Retry deadlines by optional endpoint URL; keeps a slow sibling from hiding the required result. */
  optionalRetry?: Map<string, OptionalDeferral>;
  nextAttemptAt: number;
  /** The one run that currently owns this entry; absent between runs and after a cancel. */
  run?: Run;
}

function emptySnapshot(target: ResolvedTarget, status: TargetStatus, now: number, notice?: string): TargetSnapshot {
  return {
    identity: target.identity,
    status,
    metrics: [],
    fetchedAt: now,
    source: "cache",
    ...(notice !== undefined ? { notice } : {}),
  };
}

function mergeNotice(...values: Array<string | undefined>): string | undefined {
  const parts = values.filter((value): value is string => value !== undefined && value !== "");
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function cancelledSnapshot(target: ResolvedTarget, now: number): TargetSnapshot {
  return {
    identity: target.identity,
    status: "error",
    metrics: [],
    error: "refresh cancelled",
    fetchedAt: now,
    source: "cache",
  };
}

function endpointLabel(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * Combine the required result with optional sibling results (for example
 * OpenRouter account credits next to the key budget) without merging scopes.
 */
function successfulSnapshot(
  target: ResolvedTarget,
  request: PlannedRequest,
  results: readonly ParseResult[],
  notices: readonly string[],
  now: number,
  headerResults: readonly ParseResult[],
): TargetSnapshot {
  const metrics: UsageMetric[] = [];
  for (const result of results) {
    for (const metric of result.metrics) {
      if (!metrics.some((existing) => existing.id === metric.id)) metrics.push(metric);
    }
  }
  for (const headerResult of headerResults) {
    for (const metric of headerResult.metrics) {
      if (!metrics.some((existing) => existing.id === metric.id)) metrics.push(metric);
    }
  }
  const notice = mergeNotice(
    ...results.map((result) => result.notice),
    ...notices,
    ...headerResults.map((headerResult) => headerResult.notice),
  );
  const primary = results[0];
  // Only the path and origin are reported; query strings are never shown.
  const base = {
    identity: target.identity,
    status: "ok" as const,
    metrics,
    ...(notice !== undefined ? { notice } : {}),
    fetchedAt: now,
    source: "http" as const,
  };
  return primary === undefined
    ? base
    : { ...base, scheme: primary.scheme, endpoint: endpointLabel(request.url) };
}

function failureSnapshot(
  target: ResolvedTarget,
  status: TargetStatus,
  now: number,
  error: string,
  nextRetryAt: number,
  endpoint?: string,
): TargetSnapshot {
  return {
    identity: target.identity,
    status,
    metrics: [],
    error,
    fetchedAt: now,
    source: "cache",
    nextRetryAt,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

function retryAfterMs(headers: Record<string, string>, now: number, fallback: number): number {
  const seconds = parseRetryAfterSeconds(getHeader(headers, "retry-after"), now);
  if (seconds === undefined) return fallback;
  return Math.min(Math.max(seconds * 1000, 1000), 60 * 60_000);
}

function isStatusUnavailableBody(body: string): boolean {
  return body.includes("status_unavailable");
}

function optionalDeferralNotice(label: string, reason: OptionalDeferral["reason"]): string {
  return reason === "rate-limited"
    ? `${label} is rate limited; waiting for its retry window`
    : `${label} is unavailable; waiting for its retry window`;
}

export class UsageMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly policyOverride: Partial<HttpPolicy>;
  private closed = false;

  constructor(options: MonitorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.policyOverride = options.policy ?? {};
  }

  /**
   * Configured limits bound real requests; an injected test policy takes
   * precedence over the configuration so tests stay deterministic.
   */
  private policyFor(config: UsageConfig): HttpPolicy {
    return {
      timeoutMs: this.policyOverride.timeoutMs ?? config.timeoutMs,
      maxBodyBytes: this.policyOverride.maxBodyBytes ?? config.maxBodyBytes,
    };
  }

  snapshotFor(key: string): TargetSnapshot | undefined {
    return this.entries.get(key)?.snapshot;
  }

  isStale(snapshot: TargetSnapshot, config: UsageConfig): boolean {
    return this.now() - snapshot.fetchedAt > config.refreshSeconds * 2000;
  }

  /**
   * Refresh one target. Concurrent calls for the same identity share one request
   * sequence and its account-scoped result.
   */
  refresh(
    target: ResolvedTarget,
    provider: ProviderConfig | undefined,
    config: UsageConfig,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<TargetSnapshot> {
    if (this.closed) return Promise.resolve(emptySnapshot(target, "unknown", this.now(), "monitor is shut down"));
    const key = target.identity.key;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { nextAttemptAt: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    if (options.force !== true && current.nextAttemptAt > this.now()) {
      const cached = current.snapshot;
      if (cached !== undefined) return Promise.resolve(cached);
      return Promise.resolve(emptySnapshot(target, "unknown", this.now(), "waiting before the next attempt"));
    }
    if (current.run !== undefined) return current.run.promise;

    // One record owns the request sequence and the controller that cancels it.
    // Install it before any work starts, so even a path that answers without a
    // network await is joinable and cancellable through its entry; its promise
    // is attached immediately below.
    const run: Run = { controller: new AbortController() } as Run;
    current.run = run;
    run.promise = this.executeRun(target, provider, config, current, run, options.signal).finally(() => {
      // A cancelled entry may already have installed a replacement run.
      if (current.run === run) current.run = undefined;
    });
    return run.promise;
  }

  /**
   * Parse passive response headers from an inference response for the active
   * target. The result is display-only: it is never written into the cache, so a
   * later refresh can never serve it back and `/usage` never sees it. The caller
   * owns attribution; an explicitly disabled provider produces nothing, so a live
   * response cannot revive a disabled footer.
   */
  passiveSnapshot(
    target: ResolvedTarget,
    headers: Record<string, string>,
    status: number,
    config: UsageConfig,
  ): TargetSnapshot | undefined {
    if (this.closed) return undefined;
    if (config.providers.get(target.identity.providerId)?.enabled === false) return undefined;
    const now = this.now();
    const results = parseHeaderPayload(headers, status, now);
    if (results.length === 0) return undefined;
    const metrics: UsageMetric[] = [];
    for (const result of results) {
      for (const metric of result.metrics) metrics.push(metric);
    }
    const rejected = results.some((result) => result.rateLimited === true) || status === 429;
    const notice = mergeNotice(...results.map((result) => result.notice));
    return {
      identity: target.identity,
      status: rejected ? "rate-limited" : "ok",
      scheme: results[0]?.scheme,
      metrics,
      ...(notice !== undefined ? { notice } : {}),
      ...(rejected ? { error: "the provider reported a rate limit" } : {}),
      fetchedAt: now,
      source: "headers",
    };
  }

  /**
   * Abort every in-flight run and detach it from its entry, so a replacement
   * refresh starts new work instead of joining the cancelled run. Each run is
   * reachable through the entry that owns it.
   */
  cancel(): void {
    for (const entry of this.entries.values()) {
      const run = entry.run;
      if (run !== undefined) this.detach(entry, run);
    }
  }

  /**
   * Detach one run from its entry and abort it. A cancelled run must never stay
   * joinable, or a replacement would inherit its cancellation, while a run that
   * has already been replaced must not detach its replacement.
   */
  private detach(entry: Entry, run: Run): void {
    if (entry.run === run) entry.run = undefined;
    run.controller.abort();
  }

  /** Idempotent shutdown: abort in-flight requests, forget cached state, refuse new work. */
  dispose(): void {
    if (this.closed) return;
    this.cancel();
    this.entries.clear();
    this.closed = true;
  }

  /**
   * A run may only write into its entry while it is still that entry's exact run
   * and its controller has not been aborted. Cancelling detaches synchronously,
   * so late work can neither overwrite a replacement run's snapshot, endpoint
   * preference or retry deadline nor revive a cancelled entry.
   */
  private isOwned(entry: Entry, run: Run): boolean {
    return entry.run === run && !run.controller.signal.aborted;
  }

  /**
   * Run one request sequence for an installed run, forwarding the caller's
   * cancellation onto the run's own controller. Cancellation detaches first, so
   * a replacement never joins work its parent aborted.
   */
  private async executeRun(
    target: ResolvedTarget,
    provider: ProviderConfig | undefined,
    config: UsageConfig,
    entry: Entry,
    run: Run,
    parent: AbortSignal | undefined,
  ): Promise<TargetSnapshot> {
    const abortFromParent = () => this.detach(entry, run);
    const forwardParent = parent !== undefined && !parent.aborted;
    if (forwardParent) parent.addEventListener("abort", abortFromParent, { once: true });

    try {
      if (parent?.aborted === true) {
        // An already-cancelled caller must not leave a joinable run behind.
        this.detach(entry, run);
        return cancelledSnapshot(target, this.now());
      }
      return await this.runPlan(target, provider, config, entry, run);
    } finally {
      if (forwardParent) parent?.removeEventListener("abort", abortFromParent);
    }
  }

  private async runPlan(
    target: ResolvedTarget,
    provider: ProviderConfig | undefined,
    config: UsageConfig,
    entry: Entry,
    run: Run,
  ): Promise<TargetSnapshot> {
    const signal = run.controller.signal;
    if (provider?.enabled === false) {
      const snapshot = emptySnapshot(target, "unsupported", this.now(), "disabled in pi-universal-usage.json");
      entry.snapshot = snapshot;
      entry.nextAttemptAt = this.now() + AUTH_FAILURE_BACKOFF_MS;
      return snapshot;
    }

    const plan = planEndpoints(target, provider, config);
    if (plan.kind === "none") {
      const snapshot = emptySnapshot(target, plan.status, this.now(), plan.notice);
      entry.snapshot = snapshot;
      entry.nextAttemptAt = this.now() + AUTH_FAILURE_BACKOFF_MS;
      return snapshot;
    }

    const requests = this.orderedRequests(entry, plan);
    let lastError = "no quota endpoint responded with usable data";
    let lastStatus: TargetStatus = "unknown";
    /** Results from the required endpoint first, then independent optional siblings. */
    const results: ParseResult[] = [];
    const headerResults: ParseResult[] = [];
    const optionalNotices: string[] = [];
    let endpointRequest: PlannedRequest | undefined;

    for (const [index, request] of requests.entries()) {
      // A cancelled or replaced run must not start another request or write
      // optional-sibling state.
      if (!this.isOwned(entry, run)) return cancelledSnapshot(target, this.now());
      // An optional sibling that asked for a retry window is skipped until it
      // elapses; the required result keeps refreshing meanwhile.
      if (request.optional === true) {
        const deferred = entry.optionalRetry?.get(request.url.href);
        if (deferred !== undefined) {
          if (deferred.nextAttemptAt > this.now()) {
            optionalNotices.push(optionalDeferralNotice(request.label, deferred.reason));
            continue;
          }
          entry.optionalRetry?.delete(request.url.href);
        }
      }
      const outcome = await httpGet(
        request.url,
        { headers: request.headers, allowedOrigins: request.allowedOrigins },
        this.policyFor(config),
        signal,
        this.fetchImpl,
      );

      // Cancellation or replacement can land after the response resolves: a run
      // that no longer owns this entry must never write its endpoint preference,
      // snapshot, or retry deadline over the one its replacement now owns.
      if (!this.isOwned(entry, run)) return cancelledSnapshot(target, this.now());

      if (outcome.kind === "error") {
        if (outcome.reason === "aborted") return cancelledSnapshot(target, this.now());
        // An optional sibling never discards the required result, including
        // when the refused request is a redirect/origin violation.
        if (request.optional === true) {
          lastStatus = "unsupported";
          lastError = `${request.label} could not be fetched (${outcome.reason})`;
          optionalNotices.push(lastError);
          continue;
        }
        if (outcome.reason === "origin" || outcome.reason === "unsafe-url" || outcome.reason === "redirect") {
          entry.nextAttemptAt = this.now() + AUTH_FAILURE_BACKOFF_MS;
          entry.snapshot = failureSnapshot(target, "unsupported", this.now(), outcome.message, entry.nextAttemptAt);
          return entry.snapshot;
        }
        // Timeouts, oversized bodies, and network failures: try the next
        // candidate during discovery, otherwise report the failure once.
        lastStatus = "error";
        lastError = outcome.message;
        entry.nextAttemptAt = this.now() + FAILURE_BACKOFF_MS;
        if (!plan.discovery) break;
        continue;
      }

      const now = this.now();
      const status = outcome.status;
      if (status === 401 || status === 403) {
        if (request.optional === true) {
          optionalNotices.push(`${request.label} was rejected (HTTP ${status})`);
          continue;
        }
        entry.nextAttemptAt = now + AUTH_FAILURE_BACKOFF_MS;
        entry.snapshot = failureSnapshot(
          target,
          "rejected",
          now,
          `credentials were rejected (HTTP ${status})`,
          entry.nextAttemptAt,
          endpointLabel(request.url),
        );
        return entry.snapshot;
      }
      if (status === 429) {
        if (request.optional === true) {
          optionalNotices.push(`${request.label} was rate limited`);
          this.deferOptional(entry, request, now + retryAfterMs(outcome.headers, now, RATE_LIMIT_DEFAULT_MS), "rate-limited");
          continue;
        }
        entry.nextAttemptAt = now + retryAfterMs(outcome.headers, now, RATE_LIMIT_DEFAULT_MS);
        entry.snapshot = failureSnapshot(
          target,
          "rate-limited",
          now,
          "the provider reported a rate limit",
          entry.nextAttemptAt,
          endpointLabel(request.url),
        );
        return entry.snapshot;
      }
      if (status === 404 || status === 405 || status === 410 || status === 501) {
        if (entry.endpoint?.url === request.url.href) entry.endpoint = undefined;
        lastStatus = "unsupported";
        lastError = `${request.label} was not found (HTTP ${status})`;
        if (request.optional === true) {
          optionalNotices.push(lastError);
          continue;
        }
        if (!plan.discovery) {
          entry.nextAttemptAt = now + AUTH_FAILURE_BACKOFF_MS;
          entry.snapshot = failureSnapshot(target, "unsupported", now, lastError, entry.nextAttemptAt);
          return entry.snapshot;
        }
        continue;
      }
      if (status === 503) {
        if (request.optional === true) {
          optionalNotices.push(`${request.label} reports its service as unavailable`);
          this.deferOptional(entry, request, now + retryAfterMs(outcome.headers, now, UNAVAILABLE_DEFAULT_MS), "unavailable");
          continue;
        }
        entry.nextAttemptAt = now + retryAfterMs(outcome.headers, now, UNAVAILABLE_DEFAULT_MS);
        entry.snapshot = failureSnapshot(
          target,
          "unavailable",
          now,
          isStatusUnavailableBody(outcome.body)
            ? "the proxy reports its quota service as unavailable (status_unavailable)"
            : `the usage endpoint is unavailable (HTTP ${status})`,
          entry.nextAttemptAt,
          endpointLabel(request.url),
        );
        return entry.snapshot;
      }
      if (status >= 500) {
        lastStatus = "error";
        lastError = `the usage endpoint failed (HTTP ${status})`;
        if (request.optional === true) {
          optionalNotices.push(lastError);
          continue;
        }
        entry.nextAttemptAt = now + FAILURE_BACKOFF_MS;
        continue;
      }
      if (status < 200 || status >= 300) {
        lastStatus = "error";
        lastError = `unexpected HTTP ${status}`;
        if (request.optional === true) {
          optionalNotices.push(lastError);
          continue;
        }
        continue;
      }

      headerResults.push(...parseHeaderPayload(outcome.headers, status, now));
      const json = parseJsonBody(outcome.body);
      const runParse = (scheme: SchemeId | undefined): ParseResult | undefined =>
        parseJsonPayload({ json, headers: outcome.headers, status, now }, scheme);

      const result = runParse(request.scheme);
      if (result !== undefined && result.metrics.length > 0) {
        if (request.optional === true) {
          results.push(result);
          if (index === requests.length - 1) break;
          continue;
        }
        results.unshift(result);
        endpointRequest = request;
        entry.endpoint = { url: request.url.href };
        // Only independent optional siblings follow a successful required answer.
        if (!requests.slice(index + 1).some((candidate) => candidate.optional === true)) break;
        continue;
      }

      if (request.strictScheme === true) {
        lastStatus = "unsupported";
        lastError = `the response does not match the configured scheme ${request.scheme}`;
        if (request.optional === true) {
          optionalNotices.push(lastError);
          continue;
        }
        if (!plan.discovery) {
          entry.nextAttemptAt = now + AUTH_FAILURE_BACKOFF_MS;
          entry.snapshot = failureSnapshot(target, "unsupported", now, lastError, entry.nextAttemptAt);
          return entry.snapshot;
        }
        continue;
      }

      // A hint or discovery request can answer with a different compatible
      // scheme; an explicit user selection never falls back this way.
      const generic = request.scheme === undefined ? undefined : runParse(undefined);
      if (generic !== undefined && generic.metrics.length > 0) {
        if (request.optional === true) {
          results.push(generic);
          if (index === requests.length - 1) break;
          continue;
        }
        results.unshift(generic);
        endpointRequest = request;
        entry.endpoint = { url: request.url.href };
        if (!requests.slice(index + 1).some((candidate) => candidate.optional === true)) break;
        continue;
      }

      lastStatus = "unsupported";
      lastError = json === undefined ? "the endpoint answered without a JSON body" : "the endpoint answered without recognized quota data";
      if (request.optional === true) {
        optionalNotices.push(`${request.label}: ${lastError}`);
        continue;
      }
      if (!plan.discovery) {
        entry.nextAttemptAt = now + AUTH_FAILURE_BACKOFF_MS;
        entry.snapshot = failureSnapshot(target, "unsupported", now, lastError, entry.nextAttemptAt);
        return entry.snapshot;
      }
    }

    if (results.length > 0 && endpointRequest !== undefined) {
      const snapshot = successfulSnapshot(target, endpointRequest, results, optionalNotices, this.now(), headerResults);
      entry.nextAttemptAt = this.now() + config.refreshSeconds * 1000;
      entry.snapshot = snapshot;
      return snapshot;
    }

    // Exhausted discovery with only 404s or unrecognized schemas is a stable
    // unsupported result, not a transient failure: use the same 30-minute
    // negative cache as an explicit unsupported endpoint.
    entry.nextAttemptAt = this.now() + (lastStatus === "unsupported" ? AUTH_FAILURE_BACKOFF_MS : FAILURE_BACKOFF_MS);
    entry.snapshot = failureSnapshot(target, lastStatus, this.now(), lastError, entry.nextAttemptAt);
    return entry.snapshot;
  }

  /**
   * Remember an optional endpoint's retry deadline, so a `Retry-After` from a
   * sibling request is honored instead of being retried every refresh.
   */
  private deferOptional(
    entry: Entry,
    request: PlannedRequest,
    nextAttemptAt: number,
    reason: OptionalDeferral["reason"],
  ): void {
    const deferred = entry.optionalRetry ?? new Map<string, OptionalDeferral>();
    entry.optionalRetry = deferred;
    deferred.set(request.url.href, { nextAttemptAt, reason });
  }

  /**
   * Prefer the endpoint that worked before, then the planned order. Only the
   * URL is remembered: headers are rebuilt from the current resolved target on
   * every refresh, so a rotated credential or changed routing header cannot be
   * replayed from the cache.
   */
  private orderedRequests(entry: Entry, plan: Extract<EndpointPlan, { kind: "requests" }>): PlannedRequest[] {
    const cached = entry.endpoint;
    if (cached === undefined) return plan.requests;
    const known = plan.requests.find((request) => request.url.href === cached.url);
    if (known === undefined) return plan.requests;
    return [known, ...plan.requests.filter((request) => request !== known)];
  }
}

function parseJsonBody(body: string): unknown {
  if (body.trim() === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
