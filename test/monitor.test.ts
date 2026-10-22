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
