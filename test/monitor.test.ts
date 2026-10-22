import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTarget, type ResolvedTarget } from "../src/auth.ts";
import { normalizeConfig } from "../src/config.ts";
import { formatReport } from "../src/format.ts";
import { UsageMonitor } from "../src/monitor.ts";
import { fakeModel, fakeRegistry, jsonResponse, sequenceFetch, textResponse } from "./helpers.ts";

const NOW = 1_768_000_000_000;

async function targetFor(options: {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string | null>;
}): Promise<ResolvedTarget> {
  const model = fakeModel({
    provider: options.provider,
    id: "test-model",
    baseUrl: options.baseUrl,
    api: options.api ?? "openai-responses",
  });
  const registry = fakeRegistry(
    { apiKey: options.apiKey ?? "test-key", ...(options.headers !== undefined ? { headers: options.headers } : {}) },
    [model],
  );
  const resolution = await resolveTarget(registry, model, { allowInsecureHttp: true });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) throw new Error("unreachable");
  return resolution.target;
}

function monitorWith(fetchImpl: typeof fetch): UsageMonitor {
  return new UsageMonitor({ now: () => NOW, fetchImpl, policy: { timeoutMs: 200 } });
}

const config = normalizeConfig({ refreshSeconds: 300 });

describe("UsageMonitor", () => {
  it("fetches a known first-party endpoint once and serves the cached snapshot", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "5.00" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const first = await monitor.refresh(target, undefined, config);
    assert.equal(first.status, "ok");
    assert.equal(first.source, "http");
    assert.equal(first.endpoint, "https://api.deepseek.com/user/balance");
    assert.equal(first.metrics[0]?.remaining, 5);

    const second = await monitor.refresh(target, undefined, config);
    assert.equal(second, first);
    assert.equal(calls.length, 1);

    const forced = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(forced.status, "ok");
    assert.equal(calls.length, 2);
  });

  it("shares one request sequence between concurrent refreshes", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      await gate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }] });
    }) as unknown as typeof fetch;
    const monitor = monitorWith(fetchImpl);
    const first = monitor.refresh(target, undefined, config);
    const second = monitor.refresh(target, undefined, config);
    release?.();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
  });

  it("backs off on 429 and honors Retry-After", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("slow down", { status: 429, headers: { "retry-after": "30" } })]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "rate-limited");
    assert.equal(snapshot.nextRetryAt, NOW + 30_000);
    const again = await monitor.refresh(target, undefined, config);
    assert.equal(again, snapshot);
    assert.equal(calls.length, 1);
  });

  it("stops on rejected credentials without probing more candidates", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("unauthorized", { status: 401 })]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "rejected");
    assert.match(snapshot.error ?? "", /401/);
    assert.equal(calls.length, 1);
  });

  it("discovers the Codex alias after a 404 and caches the working endpoint", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1", apiKey: "cpa-key" });
    const weekly = {
      plan_type: "unknown",
      quota_mode: "shadow",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: null,
        secondary_window: { used_percent: 73, limit_window_seconds: 604800, reset_after_seconds: 60 },
      },
    };
    const { fetchImpl, calls } = sequenceFetch([
      textResponse("not found", { status: 404 }),
      jsonResponse(weekly),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.scheme, "codex-json");
    assert.equal(snapshot.endpoint, "http://localhost:8317/backend-api/wham/usage");
    assert.equal(snapshot.metrics[0]?.usedPercent, 73);
    assert.match(snapshot.notice ?? "", /shadow/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers.authorization, "Bearer cpa-key");

    // The successful endpoint is tried first next time.
    const refreshed = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(refreshed.endpoint, "http://localhost:8317/backend-api/wham/usage");
    assert.equal(calls[2]?.url, "http://localhost:8317/backend-api/wham/usage");
  });

  it("reports a CPA status_unavailable response honestly", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const { fetchImpl } = sequenceFetch([textResponse(JSON.stringify({ error: "status_unavailable" }), { status: 503 })]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "unavailable");
    assert.match(snapshot.error ?? "", /status_unavailable/);
  });

  it("tries the next candidate after a non-JSON answer during discovery", async () => {
    const target = await targetFor({ provider: "mystery-proxy", baseUrl: "https://proxy.example.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([
      textResponse("<html>hello</html>"),
      jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "2" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.scheme, "deepseek-balance");
    assert.equal(calls.length, 2);
  });

  it("negatively caches exhausted unsupported discovery for 30 minutes", async () => {
    const target = await targetFor({ provider: "mystery-proxy", baseUrl: "https://proxy.example.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("not found", { status: 404 })]);
    let now = NOW;
    const monitor = new UsageMonitor({ now: () => now, fetchImpl, policy: { timeoutMs: 200 } });
    const discoveryConfig = normalizeConfig({ maxDiscoveryRequests: 2 });
    const snapshot = await monitor.refresh(target, undefined, discoveryConfig);
    assert.equal(snapshot.status, "unsupported");
    assert.equal(calls.length, 2);
    assert.equal(snapshot.nextRetryAt, NOW + 30 * 60_000);

    // A transient-error backoff would retry after 60 seconds; an unsupported
    // discovery result stays negatively cached.
    now += 61_000;
    assert.equal(await monitor.refresh(target, undefined, discoveryConfig), snapshot);
    assert.equal(calls.length, 2);

    now = (snapshot.nextRetryAt ?? now) + 1;
    const retried = await monitor.refresh(target, undefined, discoveryConfig);
    assert.equal(retried.status, "unsupported");
    assert.equal(calls.length, 4);

    // An explicit refresh still bypasses the negative cache.
    await monitor.refresh(target, undefined, discoveryConfig, { force: true });
    assert.equal(calls.length, 6);
  });

  it("does not transmit an explicitly suppressed credential on a real request", async () => {
    const target = await targetFor({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "credential",
      headers: { Authorization: null, "X-Custom-Auth": "routing-auth" },
    });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.authorization, undefined);
    assert.equal(calls[0]?.headers["x-custom-auth"], "routing-auth");
  });

  it("sends the Kimi quota bearer for a native API key", async () => {
    const target = await targetFor({
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      api: "anthropic-messages",
    });
    const { fetchImpl, calls } = sequenceFetch([jsonResponse({ usage: { limit: 1000, used: 250 } })]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.kimi.com/coding/v1/usages");
    assert.equal(calls[0]?.headers.authorization, "Bearer test-key");
  });

  it("does not accept a Z.ai error envelope as a successful snapshot", async () => {
    const target = await targetFor({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "zai-key" });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ code: 500, success: false, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }] } }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.notEqual(snapshot.status, "ok");
    assert.equal(snapshot.status, "unsupported");
    assert.deepEqual(snapshot.metrics, []);
    assert.equal(calls.length, 1);
  });

  it("does not request anything for a provider without a quota interface", async () => {
    const target = await targetFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "unsupported");
    assert.equal(calls.length, 0);
    assert.match(snapshot.notice ?? "", /OAuth/);
  });

  it("requests an explicitly disabled provider not at all", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, { enabled: false }, config);
    assert.equal(snapshot.status, "unsupported");
    assert.match(snapshot.notice ?? "", /disabled/);
    assert.equal(calls.length, 0);
  });

  it("reports a malformed configured path instead of rejecting the refresh", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, { path: "//%", pathMode: "origin" }, config);
    assert.equal(calls.length, 0);
    assert.equal(snapshot.status, "unsupported");
    assert.match(snapshot.notice ?? "", /could not be resolved to a valid URL/);
    assert.equal(snapshot.error, undefined);
  });

  it("ignores a malformed configured path from the file and still refreshes", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "2.00" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const fileConfig = normalizeConfig({ providers: { deepseek: { path: "//%", pathMode: "origin" } } });
    const snapshot = await monitor.refresh(target, fileConfig.providers.get("deepseek"), fileConfig);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.deepseek.com/user/balance");
    assert.equal(snapshot.status, "ok");
    assert.match(fileConfig.problems.join(" "), /deepseek\.path must be an absolute path/);
  });

  it("applies passive headers when no fresh endpoint snapshot exists", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://gateway.example.com/v1" });
    const monitor = monitorWith(sequenceFetch([textResponse("")]).fetchImpl);
    const snapshot = monitor.applyPassiveHeaders(
      target,
      { "x-codex-secondary-used-percent": "55", "x-codex-secondary-window-minutes": "10080" },
      200,
      config,
    );
    assert.ok(snapshot);
    assert.equal(snapshot.source, "headers");
    assert.equal(snapshot.scheme, "codex-headers");
    assert.equal(snapshot.metrics[0]?.usedPercent, 55);
    assert.equal(monitor.snapshotFor(target.identity.key), snapshot);
  });

  it("keeps a fresh endpoint snapshot over response headers", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "9" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const http = await monitor.refresh(target, undefined, config);
    const passive = monitor.applyPassiveHeaders(target, { "x-ratelimit-limit-requests": "10" }, 200, config);
    assert.equal(passive, http);
  });

  it("does not serve a passive snapshot cached by another logical model", async () => {
    const modelA = fakeModel({ provider: "openai", id: "chat-a", baseUrl: "https://api.openai.com/v1" });
    const modelB = fakeModel({ provider: "openai", id: "chat-b", baseUrl: "https://api.openai.com/v1" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok, true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    // Same provider, origin, credential, and routing: one account-level entry.
    assert.equal(resolvedA.target.identity.key, resolvedB.target.identity.key);

    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    const forA = await monitor.refresh(resolvedA.target, undefined, config);
    assert.equal(forA.status, "unsupported");
    assert.equal(calls.length, 0);

    const passiveA = monitor.applyPassiveHeaders(
      resolvedA.target,
      { "x-codex-secondary-used-percent": "90", "x-codex-secondary-window-minutes": "10080" },
      200,
      config,
    );
    assert.equal(passiveA?.metrics[0]?.usedPercent, 90);

    // The same model keeps serving its own passive measurement from the cache.
    assert.equal(await monitor.refresh(resolvedA.target, undefined, config), passiveA);

    // Another model of the same account must not inherit A's passive measurement.
    const forB = await monitor.refresh(resolvedB.target, undefined, config);
    assert.notEqual(forB, passiveA);
    assert.equal(forB.metrics.length, 0);
    assert.notEqual(forB.status, "ok");
    assert.match(forB.notice ?? "", /waiting before the next attempt/);
    assert.equal(calls.length, 0);
  });

  it("keeps a same-model passive measurement when a forced refresh has no endpoint", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    const passive = monitor.applyPassiveHeaders(
      target,
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" },
      200,
      config,
    );
    assert.equal(passive?.metrics[0]?.usedPercent, 75);

    // `/usage` forces a refresh; with no requestable endpoint the known
    // measurement must survive with its original timestamp.
    const forced = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(forced.source, "headers");
    assert.equal(forced.status, "ok");
    assert.equal(forced.fetchedAt, passive?.fetchedAt);
    assert.deepEqual(forced.metrics, passive?.metrics);
    assert.match(forced.notice ?? "", /no subscription quota endpoint is requested/);
    assert.equal(await monitor.refresh(target, undefined, config), forced);
    assert.equal(calls.length, 0);
  });

  it("does not serve another model's passive measurement when no endpoint is requestable", async () => {
    const modelA = fakeModel({ provider: "openai", id: "chat-a", baseUrl: "https://api.openai.com/v1" });
    const modelB = fakeModel({ provider: "openai", id: "chat-b", baseUrl: "https://api.openai.com/v1" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok, true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    assert.equal(resolvedA.target.identity.key, resolvedB.target.identity.key);

    const monitor = monitorWith(sequenceFetch([textResponse("unused")]).fetchImpl);
    const passiveA = monitor.applyPassiveHeaders(
      resolvedA.target,
      { "x-codex-secondary-used-percent": "90" },
      200,
      config,
    );
    assert.equal(passiveA?.metrics[0]?.usedPercent, 90);

    const forcedB = await monitor.refresh(resolvedB.target, undefined, config, { force: true });
    assert.deepEqual(forcedB.metrics, []);
    assert.notEqual(forcedB.status, "ok");
  });

  it("does not hand an in-flight join another model's passive measurement", async () => {
    const modelA = fakeModel({ provider: "openai", id: "chat-a", baseUrl: "https://api.openai.com/v1" });
    const modelB = fakeModel({ provider: "openai", id: "chat-b", baseUrl: "https://api.openai.com/v1" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok, true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    // Same provider, origin, and credential: one account-level entry.
    assert.equal(resolvedA.target.identity.key, resolvedB.target.identity.key);

    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    const passiveA = monitor.applyPassiveHeaders(
      resolvedA.target,
      { "x-codex-secondary-used-percent": "90" },
      200,
      config,
    );
    assert.equal(passiveA?.metrics[0]?.usedPercent, 90);

    // A no-endpoint run retains A's passive snapshot synchronously while its
    // promise and cleanup are still pending, so B joins it without awaiting.
    const forcedA = monitor.refresh(resolvedA.target, undefined, config, { force: true });
    const forcedB = monitor.refresh(resolvedB.target, undefined, config, { force: true });
    const [forA, forB] = await Promise.all([forcedA, forcedB]);

    // The model that produced the measurement keeps it.
    assert.equal(forA.source, "headers");
    assert.equal(forA.metrics[0]?.usedPercent, 90);
    // The joining model never inherits it.
    assert.deepEqual(forB.metrics, []);
    assert.notEqual(forB.status, "ok");
    assert.notEqual(forB.source, "headers");
    assert.equal(calls.length, 0);
  });

  it("shares an endpoint result with a joining model of the same account", async () => {
    const modelA = fakeModel({ provider: "deepseek", id: "chat-a", baseUrl: "https://api.deepseek.com" });
    const modelB = fakeModel({ provider: "deepseek", id: "chat-b", baseUrl: "https://api.deepseek.com" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok, true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    assert.equal(resolvedA.target.identity.key, resolvedB.target.identity.key);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      await gate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4" }] });
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);
    const forA = monitor.refresh(resolvedA.target, undefined, config, { force: true });
    const forB = monitor.refresh(resolvedB.target, undefined, config, { force: true });
    release?.();
    const [a, b] = await Promise.all([forA, forB]);
    assert.equal(calls.length, 1);
    assert.equal(b, a);
    assert.equal(a.source, "http");
    assert.equal(a.status, "ok");
  });

  it("does not restart a joined refresh after its run was cancelled", async () => {
    const modelA = fakeModel({ provider: "openai", id: "chat-a", baseUrl: "https://api.openai.com/v1" });
    const modelB = fakeModel({ provider: "openai", id: "chat-b", baseUrl: "https://api.openai.com/v1" });
    const modelC = fakeModel({ provider: "openai", id: "chat-c", baseUrl: "https://api.openai.com/v1" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB, modelC]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    const resolvedC = await resolveTarget(registry, modelC, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok && resolvedC.ok, true);
    if (!resolvedA.ok || !resolvedB.ok || !resolvedC.ok) return;
    // One account-level entry for all three models.
    assert.equal(resolvedA.target.identity.key, resolvedB.target.identity.key);
    assert.equal(resolvedA.target.identity.key, resolvedC.target.identity.key);

    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    monitor.applyPassiveHeaders(resolvedA.target, { "x-codex-secondary-used-percent": "90" }, 200, config);

    // A's no-endpoint run has already retained its snapshot while its promise is
    // pending, so B joins it; cancelling detaches and aborts that run.
    const forcedA = monitor.refresh(resolvedA.target, undefined, config, { force: true });
    const forcedB = monitor.refresh(resolvedB.target, undefined, config, { force: true });
    monitor.cancel();
    const replacement = monitor.applyPassiveHeaders(
      resolvedC.target,
      { "x-codex-secondary-used-percent": "25" },
      200,
      config,
    );
    assert.equal(replacement?.metrics[0]?.usedPercent, 25);

    const [forA, forB] = await Promise.all([forcedA, forcedB]);
    // The cancelled join carries no measurement and starts no replacement run,
    // so the newer measurement of another model survives untouched.
    assert.equal(forA.metrics[0]?.usedPercent, 90);
    assert.deepEqual(forB.metrics, []);
    assert.notEqual(forB.status, "ok");
    const cached = monitor.snapshotFor(resolvedC.target.identity.key);
    assert.equal(cached?.metrics[0]?.usedPercent, 25);
    assert.equal(cached?.identity.modelId, "chat-c");
    assert.equal(calls.length, 0);
  });

  it("does not restart a joined refresh whose caller was already cancelled", async () => {
    const modelA = fakeModel({ provider: "openai", id: "chat-a", baseUrl: "https://api.openai.com/v1" });
    const modelB = fakeModel({ provider: "openai", id: "chat-b", baseUrl: "https://api.openai.com/v1" });
    const modelC = fakeModel({ provider: "openai", id: "chat-c", baseUrl: "https://api.openai.com/v1" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB, modelC]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    const resolvedC = await resolveTarget(registry, modelC, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok && resolvedC.ok, true);
    if (!resolvedA.ok || !resolvedB.ok || !resolvedC.ok) return;
    assert.equal(resolvedA.target.identity.key, resolvedC.target.identity.key);

    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    monitor.applyPassiveHeaders(resolvedA.target, { "x-codex-secondary-used-percent": "90" }, 200, config);

    const controller = new AbortController();
    const forcedA = monitor.refresh(resolvedA.target, undefined, config, { force: true });
    const forcedB = monitor.refresh(resolvedB.target, undefined, config, { force: true, signal: controller.signal });
    controller.abort();
    monitor.applyPassiveHeaders(resolvedC.target, { "x-codex-secondary-used-percent": "25" }, 200, config);

    const [forA, forB] = await Promise.all([forcedA, forcedB]);
    assert.equal(forA.metrics[0]?.usedPercent, 90);
    assert.equal(forB.status, "error");
    assert.deepEqual(forB.metrics, []);
    assert.equal(monitor.snapshotFor(resolvedC.target.identity.key)?.metrics[0]?.usedPercent, 25);
    assert.equal(calls.length, 0);
  });

  it("does not let a join overwrite work cancelled after the owner finished", async () => {
    const modelA = fakeModel({ provider: "openai", id: "chat-a", baseUrl: "https://api.openai.com/v1" });
    const modelB = fakeModel({ provider: "openai", id: "chat-b", baseUrl: "https://api.openai.com/v1" });
    const modelC = fakeModel({ provider: "openai", id: "chat-c", baseUrl: "https://api.openai.com/v1" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB, modelC]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    const resolvedC = await resolveTarget(registry, modelC, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok && resolvedC.ok, true);
    if (!resolvedA.ok || !resolvedB.ok || !resolvedC.ok) return;
    assert.equal(resolvedA.target.identity.key, resolvedC.target.identity.key);

    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    monitor.applyPassiveHeaders(resolvedA.target, { "x-codex-secondary-used-percent": "90" }, 200, config);

    // The owner's observer runs before the joiner's continuation and its cleanup
    // has already removed the run from the entry, so cancel() has nothing left to
    // abort. The outstanding join must still not start work afterwards.
    const owner = monitor.refresh(resolvedA.target, undefined, config, { force: true });
    let replacement: ReturnType<typeof monitor.applyPassiveHeaders>;
    const cancelledAfterOwner = owner.then(() => {
      monitor.cancel();
      replacement = monitor.applyPassiveHeaders(
        resolvedC.target,
        { "x-codex-secondary-used-percent": "25" },
        200,
        config,
      );
    });
    const joiner = monitor.refresh(resolvedB.target, undefined, config, { force: true });

    const [, forB] = await Promise.all([cancelledAfterOwner, joiner]);
    assert.equal(replacement?.metrics[0]?.usedPercent, 25);
    assert.deepEqual(forB.metrics, []);
    assert.notEqual(forB.status, "ok");
    const cached = monitor.snapshotFor(resolvedC.target.identity.key);
    assert.equal(cached?.metrics[0]?.usedPercent, 25);
    assert.equal(cached?.identity.modelId, "chat-c");
    assert.equal(calls.length, 0);
  });

  it("does not retain a passive measurement past an explicit disable", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    monitor.applyPassiveHeaders(target, { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" }, 200, config);
    const disabled = await monitor.refresh(target, { enabled: false }, config, { force: true });
    assert.equal(disabled.status, "unsupported");
    assert.match(disabled.notice ?? "", /disabled/);
    assert.deepEqual(disabled.metrics, []);
    assert.equal(calls.length, 0);
  });

  it("ignores passive response headers for an explicitly disabled provider", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("unused")]);
    const monitor = monitorWith(fetchImpl);
    const provider = { enabled: false };
    const disabledConfig = normalizeConfig({ refreshSeconds: 300, providers: { openai: provider } });
    const disabled = await monitor.refresh(target, provider, disabledConfig, { force: true });
    assert.equal(disabled.status, "unsupported");
    assert.match(disabled.notice ?? "", /disabled/);

    // The inference response still arrives; it must not overwrite the disabled
    // snapshot or produce a snapshot the footer would paint.
    const passive = monitor.applyPassiveHeaders(
      target,
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" },
      200,
      disabledConfig,
    );
    assert.equal(passive, undefined);
    assert.equal(monitor.snapshotFor(target.identity.key), disabled);

    // Subsequent ordinary refreshes keep serving the disabled state.
    const next = await monitor.refresh(target, provider, disabledConfig);
    assert.equal(next, disabled);
    assert.equal(calls.length, 0);
  });

  it("reuses an account-level endpoint snapshot across models of one provider", async () => {
    const modelA = fakeModel({ provider: "deepseek", id: "chat-a", baseUrl: "https://api.deepseek.com" });
    const modelB = fakeModel({ provider: "deepseek", id: "chat-b", baseUrl: "https://api.deepseek.com" });
    const registry = fakeRegistry({ apiKey: "test-key" }, [modelA, modelB]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok, true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    assert.equal(resolvedA.target.identity.key, resolvedB.target.identity.key);

    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const forA = await monitor.refresh(resolvedA.target, undefined, config);
    assert.equal(forA.status, "ok");

    const forB = await monitor.refresh(resolvedB.target, undefined, config);
    assert.equal(forB, forA);
    assert.equal(calls.length, 1);
  });

  it("cancels an in-flight refresh and refuses work after shutdown", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const monitor = monitorWith(fetchImpl);
    const pending = monitor.refresh(target, undefined, config);
    monitor.cancel();
    const snapshot = await pending;
    assert.equal(snapshot.status, "error");
    assert.match(snapshot.error ?? "", /cancelled/);

    monitor.dispose();
    monitor.dispose();
    const after = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(after.status, "unknown");
    assert.equal(monitor.snapshotFor(target.identity.key), undefined);
  });

  it("never reuses another credential's cached headers for the same provider origin", async () => {
    const modelA = fakeModel({ provider: "cpa", id: "chat-a", baseUrl: "http://localhost:8317/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat-b", baseUrl: "http://localhost:8317/v1" });
    const authFor = (model: { id: string }) =>
      model.id === "chat-a"
        ? { apiKey: "key-a", headers: { "x-routing": "a" } }
        : { apiKey: "key-b", headers: { "x-routing": "b" } };
    const registry = fakeRegistry((model) => authFor(model as { id: string }), [modelA, modelB]);
    const resolvedA = await resolveTarget(registry, modelA, { allowInsecureHttp: true });
    const resolvedB = await resolveTarget(registry, modelB, { allowInsecureHttp: true });
    assert.equal(resolvedA.ok && resolvedB.ok, true);
    if (!resolvedA.ok || !resolvedB.ok) return;

    const { fetchImpl, calls } = sequenceFetch([
      textResponse("not found", { status: 404 }),
      jsonResponse({
        rate_limit: {
          primary_window: null,
          secondary_window: { used_percent: 50, limit_window_seconds: 604800 },
        },
      }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const first = await monitor.refresh(resolvedA.target, undefined, config);
    assert.equal(first.status, "ok");
    const callsAfterA = calls.length;

    const second = await monitor.refresh(resolvedB.target, undefined, config, { force: true });
    assert.equal(second.status, "ok");
    const bCalls = calls.slice(callsAfterA);
    assert.ok(bCalls.length > 0);
    for (const call of bCalls) {
      assert.equal(call.headers.authorization, "Bearer key-b");
      assert.equal(call.headers["x-routing"], "b");
    }
  });

  it("does not fall back to another parser for an explicit scheme", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "5" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(
      target,
      { scheme: "codex-json", path: "/backend-api/wham/usage", pathMode: "origin" },
      config,
    );
    assert.equal(snapshot.status, "unsupported");
    assert.match(snapshot.error ?? "", /configured scheme codex-json/);
    assert.equal(calls.length, 1);
  });

  it("reports a headers-only override without making a request", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, { scheme: "codex-headers" }, config);
    assert.equal(snapshot.status, "unsupported");
    assert.equal(calls.length, 0);
  });

  it("merges an optional account-credit result with the OpenRouter key budget", async () => {
    const target = await targetFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ data: { limit: 20, limit_remaining: 15, limit_reset: "monthly" } }),
      jsonResponse({ data: { total_credits: 100, total_usage: 20 } }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.deepEqual(snapshot.metrics.map((metric) => metric.id).sort(), [
      "openrouter.account-credits",
      "openrouter.key-budget",
    ]);
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.url ?? "", /\/api\/v1\/credits$/);
  });

  it("keeps the required OpenRouter key result when the optional credits request redirects", async () => {
    const target = await targetFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ data: { limit: 20, limit_remaining: 15 } }),
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.deepEqual(snapshot.metrics.map((metric) => metric.id), ["openrouter.key-budget"]);
    assert.match(snapshot.notice ?? "", /credits could not be fetched \(redirect\)/);
    assert.equal(calls.length, 2);
    assert.equal(calls.some((call) => call.url.includes("elsewhere.example.com")), false);
  });

  it("fails the refresh when the required endpoint redirects", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl } = sequenceFetch([
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "unsupported");
    assert.match(snapshot.error ?? "", /redirect/i);
  });

  it("keeps a working OpenRouter key result when the optional credits request fails", async () => {
    const target = await targetFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    const { fetchImpl } = sequenceFetch([
      jsonResponse({ data: { limit: 20, limit_remaining: 15 } }),
      textResponse("unauthorized", { status: 401 }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "ok");
    assert.deepEqual(snapshot.metrics.map((metric) => metric.id), ["openrouter.key-budget"]);
    assert.match(snapshot.notice ?? "", /credits was rejected \(HTTP 401\)/);
  });

  it("honors an optional endpoint's Retry-After instead of re-requesting it early", async () => {
    const target = await targetFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    let now = NOW;
    let keyCalls = 0;
    let creditCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/v1/credits")) {
        keyCalls += 1;
        return jsonResponse({ data: { limit: 20, limit_remaining: 15 } });
      }
      creditCalls += 1;
      return textResponse("slow down", { status: 429, headers: { "retry-after": "3600" } });
    }) as typeof fetch;
    const monitor = new UsageMonitor({ now: () => now, fetchImpl, policy: { timeoutMs: 200 } });

    const first = await monitor.refresh(target, undefined, config);
    assert.equal(first.status, "ok");
    assert.deepEqual(first.metrics.map((metric) => metric.id), ["openrouter.key-budget"]);
    assert.match(first.notice ?? "", /credits was rate limited/);
    assert.equal(keyCalls, 1);
    assert.equal(creditCalls, 1);

    // Past the ordinary refresh interval, but inside the server's retry window.
    now += 301_000;
    const second = await monitor.refresh(target, undefined, config);
    assert.equal(second.status, "ok");
    assert.deepEqual(second.metrics.map((metric) => metric.id), ["openrouter.key-budget"]);
    assert.match(second.notice ?? "", /credits is rate limited; waiting for its retry window/);
    assert.equal(keyCalls, 2);
    assert.equal(creditCalls, 1);

    // Once the window elapsed, the optional endpoint is requested again.
    now += 3_600_000;
    const third = await monitor.refresh(target, undefined, config);
    assert.equal(third.status, "ok");
    assert.equal(keyCalls, 3);
    assert.equal(creditCalls, 2);
  });

  it("defers an unavailable optional endpoint until its Retry-After elapses", async () => {
    const target = await targetFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    let now = NOW;
    let creditCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/v1/credits")) return jsonResponse({ data: { limit: 20, limit_remaining: 15 } });
      creditCalls += 1;
      if (creditCalls === 1) return textResponse("", { status: 503, headers: { "retry-after": "1200" } });
      return jsonResponse({ data: { total_credits: 100, total_usage: 20 } });
    }) as typeof fetch;
    const monitor = new UsageMonitor({ now: () => now, fetchImpl, policy: { timeoutMs: 200 } });

    const first = await monitor.refresh(target, undefined, config);
    assert.equal(first.status, "ok");
    assert.deepEqual(first.metrics.map((metric) => metric.id), ["openrouter.key-budget"]);
    assert.match(first.notice ?? "", /credits reports its service as unavailable/);

    now += 301_000;
    const second = await monitor.refresh(target, undefined, config);
    assert.deepEqual(second.metrics.map((metric) => metric.id), ["openrouter.key-budget"]);
    assert.match(second.notice ?? "", /credits is unavailable; waiting for its retry window/);
    assert.equal(creditCalls, 1);

    now += 900_000;
    const third = await monitor.refresh(target, undefined, config);
    assert.deepEqual(third.metrics.map((metric) => metric.id).sort(), [
      "openrouter.account-credits",
      "openrouter.key-budget",
    ]);
    assert.equal(creditCalls, 2);
  });

  it("redacts the rejected origin from an origin-guard error and report", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(
      target,
      { path: "//private-gateway.example/quota?token=SENTINEL" },
      config,
    );
    assert.equal(snapshot.status, "unsupported");
    assert.equal(calls.length, 0);
    assert.equal(snapshot.error?.includes("private-gateway.example"), false);
    assert.equal(snapshot.error?.includes("SENTINEL"), false);
    const report = formatReport([snapshot], config, NOW).join("\n");
    assert.equal(report.includes("private-gateway.example"), false);
    assert.equal(report.includes("SENTINEL"), false);
  });

  it("redacts a fetch exception message from the snapshot and report", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const sentinel = "SENTINEL\ncredential-fragment";
    const fetchImpl = (async () => {
      throw new Error(`invalid header value: ${sentinel}`);
    }) as unknown as typeof fetch;
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.error, "network request failed");
    assert.equal(snapshot.error?.includes("SENTINEL"), false);
    const report = formatReport([snapshot], config, NOW).join("\n");
    assert.match(report, /network request failed/);
    assert.equal(report.includes("SENTINEL"), false);
  });

  it("applies the configured body limit to a real request", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const { fetchImpl } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }], padding: "x".repeat(2048) }),
    ]);
    const monitor = monitorWith(fetchImpl);
    const snapshot = await monitor.refresh(target, undefined, normalizeConfig({ maxBodyBytes: 1024 }));
    assert.equal(snapshot.status, "error");
    assert.match(snapshot.error ?? "", /exceeded 1024 bytes/);
  });

  it("applies the configured timeout when no test policy overrides it", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const monitor = new UsageMonitor({ now: () => NOW, fetchImpl });
    const snapshot = await monitor.refresh(target, undefined, normalizeConfig({ timeoutMs: 500 }));
    assert.equal(snapshot.status, "error");
    assert.match(snapshot.error ?? "", /timed out after 500ms/);
  });

  it("keeps an overall passive rejection without window metrics", async () => {
    const target = await targetFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "sk-ant-oat-x" });
    const monitor = monitorWith(sequenceFetch([textResponse("")]).fetchImpl);
    const snapshot = monitor.applyPassiveHeaders(target, { "anthropic-ratelimit-unified-status": "rejected" }, 429, config);
    assert.ok(snapshot);
    assert.equal(snapshot.status, "rate-limited");
    assert.equal(snapshot.scheme, "anthropic-headers");
    assert.match(snapshot.error ?? "", /rate limit/);
  });

  it("starts a replacement request after a cancel instead of joining cancelled work", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    let call = 0;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "6" }] }));
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);
    const cancelled = monitor.refresh(target, undefined, config);
    monitor.cancel();
    const replacement = monitor.refresh(target, undefined, config, { force: true });
    const [oldSnapshot, newSnapshot] = await Promise.all([cancelled, replacement]);
    assert.equal(oldSnapshot.status, "error");
    assert.match(oldSnapshot.error ?? "", /cancelled/);
    assert.equal(newSnapshot.status, "ok");
    assert.equal(call, 2);
  });

  it("does not let a cancelled run overwrite the replacement result or retry deadline", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let call = 0;
    // The first request ignores the abort signal and resolves after the cancel,
    // so only the run's own cancellation check can stop it from writing.
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        await oldGate;
        return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "11" }] });
      }
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "22" }] });
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);

    const cancelledRun = monitor.refresh(target, undefined, config);
    monitor.cancel();
    const replacement = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(replacement.status, "ok");
    assert.equal(replacement.metrics[0]?.remaining, 22);

    releaseOld?.();
    const old = await cancelledRun;
    assert.equal(old.status, "error");
    assert.match(old.error ?? "", /cancelled/);
    assert.equal(monitor.snapshotFor(target.identity.key)?.metrics[0]?.remaining, 22);

    const cached = await monitor.refresh(target, undefined, config);
    assert.equal(cached.metrics[0]?.remaining, 22);
    assert.equal(call, 2);
  });

  it("keeps the replacement run owned when a cancelled run finishes later", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releaseReplacement: (() => void) | undefined;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        await oldGate;
        return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "11" }] });
      }
      await replacementGate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "22" }] });
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);

    const cancelledRun = monitor.refresh(target, undefined, config);
    monitor.cancel();
    const replacement = monitor.refresh(target, undefined, config, { force: true });
    assert.equal(call, 2);

    // The cancelled run completes after the replacement was installed. Its cleanup
    // must leave the entry owned by the replacement, not detach it.
    releaseOld?.();
    const old = await cancelledRun;
    assert.equal(old.status, "error");
    assert.match(old.error ?? "", /cancelled/);

    // A refresh arriving now joins the pending replacement instead of starting a
    // third sequence, which is only possible while its ownership survived.
    const joined = monitor.refresh(target, undefined, config, { force: true });
    assert.equal(call, 2);
    releaseReplacement?.();
    const [replacementSnapshot, joinedSnapshot] = await Promise.all([replacement, joined]);
    assert.equal(replacementSnapshot.status, "ok");
    assert.equal(replacementSnapshot.metrics[0]?.remaining, 22);
    assert.equal(joinedSnapshot, replacementSnapshot);
    assert.equal(monitor.snapshotFor(target.identity.key)?.metrics[0]?.remaining, 22);
    assert.equal(call, 2);
  });

  it("does not record an optional sibling's retry window from a cancelled run", async () => {
    const target = await targetFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    let releaseCredits: (() => void) | undefined;
    const creditsGate = new Promise<void>((resolve) => {
      releaseCredits = resolve;
    });
    let creditsReached: (() => void) | undefined;
    const creditsStarted = new Promise<void>((resolve) => {
      creditsReached = resolve;
    });
    let holdCredits = true;
    let keyCalls = 0;
    let creditCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/api/v1/credits")) {
        keyCalls += 1;
        return jsonResponse({ data: { limit: 20, limit_remaining: 15 } });
      }
      creditCalls += 1;
      if (holdCredits) {
        holdCredits = false;
        creditsReached?.();
        await creditsGate;
        // A cancelled run's late rate limit must not defer the sibling for its replacement.
        return textResponse("slow down", { status: 429, headers: { "retry-after": "3600" } });
      }
      return jsonResponse({ data: { total_credits: 100, total_usage: 20 } });
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);

    const cancelledRun = monitor.refresh(target, undefined, config);
    await creditsStarted;
    assert.equal(keyCalls, 1);
    monitor.cancel();
    releaseCredits?.();
    const old = await cancelledRun;
    assert.equal(old.status, "error");
    assert.match(old.error ?? "", /cancelled/);

    const replacement = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(keyCalls, 2);
    // The replacement requests the sibling again instead of inheriting the dead run's window.
    assert.equal(creditCalls, 2);
    assert.deepEqual(replacement.metrics.map((metric) => metric.id).sort(), [
      "openrouter.account-credits",
      "openrouter.key-budget",
    ]);
    assert.doesNotMatch(replacement.notice ?? "", /retry window/);
  });

  it("aborts the run installed after a cancel on shutdown", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    let call = 0;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      call += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);

    const cancelledRun = monitor.refresh(target, undefined, config);
    monitor.cancel();
    const replacement = monitor.refresh(target, undefined, config, { force: true });
    assert.equal(call, 2);

    // Every run is reachable through the entry that owns it, so shutdown still
    // aborts the sequence installed after the cancel.
    monitor.dispose();
    const [old, replacementSnapshot] = await Promise.all([cancelledRun, replacement]);
    assert.match(old.error ?? "", /cancelled/);
    assert.equal(replacementSnapshot.status, "error");
    assert.match(replacementSnapshot.error ?? "", /cancelled/);

    const after = await monitor.refresh(target, undefined, config, { force: true });
    assert.equal(after.status, "unknown");
    assert.match(after.notice ?? "", /monitor is shut down/);
    assert.equal(call, 2);
  });

  it("detaches a run whose parent signal is aborted so a replacement starts", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const parent = new AbortController();
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        await oldGate;
        return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "11" }] });
      }
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "22" }] });
    }) as typeof fetch;
    const monitor = monitorWith(fetchImpl);

    const cancelledRun = monitor.refresh(target, undefined, config, { signal: parent.signal });
    assert.equal(call, 1);
    // A caller aborts through the parent signal, not through cancel(): the run
    // must be detached just the same, or the replacement joins its cancellation.
    parent.abort();
    const replacement = monitor.refresh(target, undefined, config, { force: true });
    assert.equal(call, 2, "the replacement starts its own request sequence");

    releaseOld?.();
    const old = await cancelledRun;
    assert.equal(old.status, "error");
    assert.match(old.error ?? "", /cancelled/);
    const replacementSnapshot = await replacement;
    assert.equal(replacementSnapshot.status, "ok");
    assert.equal(replacementSnapshot.metrics[0]?.remaining, 22);
    assert.equal(monitor.snapshotFor(target.identity.key)?.metrics[0]?.remaining, 22);
    assert.equal(call, 2);
  });

  it("starts new work when the caller's signal was already aborted", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const parent = new AbortController();
    parent.abort();
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "9" }] }),
    ]);
    const monitor = monitorWith(fetchImpl);

    const cancelledRun = monitor.refresh(target, undefined, config, { signal: parent.signal });
    // The cancelled run must not stay joinable even for a synchronous caller.
    const replacement = monitor.refresh(target, undefined, config, { force: true });
    const [old, replacementSnapshot] = await Promise.all([cancelledRun, replacement]);
    assert.equal(old.status, "error");
    assert.match(old.error ?? "", /cancelled/);
    assert.equal(replacementSnapshot.status, "ok");
    assert.equal(replacementSnapshot.metrics[0]?.remaining, 9);
    assert.equal(calls.length, 1, "only the replacement requested");
  });

  it("marks a snapshot stale after twice the refresh interval", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const monitor = new UsageMonitor({
      now: () => NOW,
      fetchImpl: sequenceFetch([
        jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }] }),
      ]).fetchImpl,
    });
    const snapshot = await monitor.refresh(target, undefined, config);
    assert.equal(monitor.isStale(snapshot, config), false);
    const later = new UsageMonitor({ now: () => NOW + 700_000 });
    assert.equal(later.isStale({ ...snapshot, fetchedAt: NOW }, normalizeConfig({ refreshSeconds: 300 })), true);
  });
});
