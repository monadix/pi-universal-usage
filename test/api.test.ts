import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { createUsageClient, formatUsageReport } from "pi-universal-usage/api";
import type { UsageReport, UsageResult } from "pi-universal-usage/api";
import { normalizeConfig } from "../src/config.ts";
import { fakeModel, fakeRegistry, jsonResponse, sequenceFetch, shortRoutingPrivacyCases, textResponse, type FakeAuth } from "./helpers.ts";

const NOW = 1_768_000_000_000;
const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
const balance = (value = "7") => jsonResponse({ balance_infos: [{ currency: "USD", total_balance: value }] });
const quota = (value = 140) => jsonResponse({
  rate_limit: { primary_window: null, secondary_window: { used_percent: value, reset_at: NOW / 1000 - 60 } },
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  // Yield only to queued work, not elapsed wall time; a missing transition fails.
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("expected observable transition did not occur");
}

function setup(options: {
  models?: ReturnType<typeof fakeModel>[];
  auth?: FakeAuth | ((model: ReturnType<typeof fakeModel>) => FakeAuth);
  rawConfig?: unknown;
  fetchImpl?: typeof fetch;
} = {}) {
  const models = options.models ?? [deepseek];
  let active: ReturnType<typeof fakeModel> | undefined = models[0];
  let now = NOW;
  const recorded = sequenceFetch([() => balance()]);
  const registry = fakeRegistry(options.auth ?? { apiKey: "synthetic-key" }, models);
  const client = createUsageClient({
    modelRegistry: registry,
    getActiveModel: () => active,
    config: normalizeConfig(options.rawConfig),
    now: () => now,
    fetchImpl: options.fetchImpl ?? recorded.fetchImpl,
  });
  return {
    client, registry, calls: recorded.calls,
    select(model: typeof active) { active = model; },
    advance(ms: number) { now += ms; },
  };
}

function only(report: UsageReport): UsageResult {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.results.length, 1);
  return report.results[0]!;
}

function publicShape(report: UsageReport) {
  const keysAre = (value: object, allowed: string[]) => {
    for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `unexpected public key ${key}`);
  };
  keysAre(report, ["schemaVersion", "generatedAt", "results", "configProblems"]);
  for (const result of report.results) {
    keysAre(result, ["provider", "modelId", "status", "metrics", "freshness", "observedAt", "source", "cacheHit", "nextRetryAt", "notice", "error"]);
    if (result.error) keysAre(result.error, ["code", "message"]);
    for (const metric of result.metrics) {
      keysAre(metric, ["id", "kind", "label", "scope", "usedPercent", "remainingPercent", "used", "limit", "remaining", "unit", "resetAtSeconds", "durationSeconds", "status", "breakdown", "source"]);
      for (const component of metric.breakdown ?? []) keysAre(component, ["label", "value"]);
      for (const value of Object.values(metric)) {
        if (typeof value === "number") assert.ok(Number.isFinite(value));
      }
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, "plain JSON, without undefined/null numeric placeholders");
}

const abortError = (error: unknown) => error instanceof Error && error.name === "AbortError";

describe("public headless usage API", { timeout: 5000 }, () => {
  it("imports and constructs in plain Node without runtime bootstrapping or side effects", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const forbidden = () => { throw new Error('unexpected import/construction side effect'); };
      const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
      globalThis.fetch = forbidden;
      globalThis.setTimeout = forbidden;
      globalThis.setInterval = forbidden;
      const { createUsageClient, formatUsageReport } = await import('pi-universal-usage/api');
      const { normalizeConfig } = await import('./src/config.ts');
      const registry = { getAll: () => [], getAvailable: () => [], getApiKeyAndHeaders: forbidden };
      const client = createUsageClient({ modelRegistry: registry });
      assert.deepEqual(client.listProviders().filter(p => p.active), []);
      assert.equal(typeof formatUsageReport, 'function');
      process.stdout.write = forbidden;
      process.stderr.write = forbidden;
      await client.read({ selection: { providers: ['unregistered'] }, refresh: 'cached' });
      client.dispose(); client.dispose();
      globalThis.setTimeout = timeout; globalThis.setInterval = interval;
      const model = { provider: 'deepseek', id: 'chat', api: 'openai-responses', baseUrl: 'https://api.deepseek.com' };
      const readyRegistry = { ...registry, getAll: () => [model],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic' }),
        getProviderAuthStatus: () => ({ configured: true, source: 'stored' }), isUsingOAuth: () => false };
      const ready = createUsageClient({ modelRegistry: readyRegistry, getActiveModel: () => model, config: normalizeConfig({}),
        fetchImpl: async () => new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '7' }] }),
          { headers: { 'content-type': 'application/json' } }) });
      const report = await ready.read();
      assert.equal(report.results[0].status, 'ok');
      assert.equal(typeof formatUsageReport(report), 'string');
      ready.dispose();
    `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "");
  });

  it("enumerates registered/configured/active IDs synchronously without resolving credentials", () => {
    const other = fakeModel({ ...deepseek, provider: "a-provider" });
    const f = setup({ models: [deepseek, other, deepseek], auth: () => { throw new Error("must not resolve"); },
      rawConfig: { providers: { unresolved: { enabled: true }, disabled: { enabled: false } } } });
    try {
      assert.deepEqual(f.client.listProviders(), [
        { provider: "a-provider", enabled: true, active: false },
        { provider: "deepseek", enabled: true, active: true },
        { provider: "disabled", enabled: false, active: false },
        { provider: "unresolved", enabled: true, active: false },
      ]);
      f.select(fakeModel({ ...deepseek, provider: "not-registered" }));
      assert.equal(f.client.listProviders().find((p) => p.provider === "not-registered")?.active, true);
      assert.equal(f.client.listProviders().find((p) => p.provider === "deepseek")?.active, false);
      assert.equal(f.calls.length, 0);
    } finally { f.client.dispose(); }
  });

  it("sanitizes enumeration IDs while preserving raw-ID deduplication, order and state flags", () => {
    const registeredId = "a-registered\u001b[31m\u202e";
    const configuredId = "m-configured\u009b31m\u2066\u0007";
    const activeId = "z-active\u001b]0;title\u0007\u2069";
    const registered = fakeModel({ ...deepseek, provider: registeredId });
    let resolutions = 0;
    const f = setup({ models: [registered, registered],
      auth: () => { resolutions++; throw new Error("enumeration must not resolve credentials"); },
      rawConfig: { providers: { [registeredId]: { enabled: false }, [configuredId]: {} } } });
    try {
      f.select(fakeModel({ ...deepseek, provider: activeId }));
      const providers = f.client.listProviders();
      for (const entry of providers) {
        assert.doesNotMatch(entry.provider, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
      }
      assert.deepEqual(providers, [
        { provider: "a-registered", enabled: false, active: false },
        { provider: "m-configured", enabled: true, active: false },
        { provider: "z-active", enabled: true, active: true },
      ]);
      f.select(registered);
      assert.deepEqual(f.client.listProviders(), [
        { provider: "a-registered", enabled: false, active: true },
        { provider: "m-configured", enabled: true, active: false },
      ]);
      assert.equal(resolutions, 0); assert.equal(f.calls.length, 0);
    } finally { f.client.dispose(); }
  });

  it("defaults to active only, deduplicates selections in order, and reports unresolved IDs", async () => {
    const peer = fakeModel({ ...deepseek, provider: "peer" });
    const f = setup({ models: [deepseek, peer], rawConfig: { providers: { peer: { enabled: true } } } });
    try {
      assert.equal(only(await f.client.read()).provider, "deepseek");
      const selected = await f.client.read({ selection: { providers: ["missing", "deepseek", "missing"] as const } });
      assert.deepEqual(selected.results.map((r) => r.provider), ["missing", "deepseek"]);
      const missing = selected.results[0]!;
      assert.equal(missing.status, "unknown"); assert.equal(missing.freshness, "missing");
      assert.equal(missing.modelId, undefined); assert.equal(missing.observedAt, undefined);
      assert.equal(missing.source, undefined); assert.deepEqual(missing.metrics, []);
      const explicit = only(await f.client.read({ selection: { models: [
        { provider: "deepseek", modelId: "absent" }, { provider: "deepseek", modelId: "absent" },
      ] } }));
      assert.equal(explicit.status, "unknown"); assert.equal(explicit.modelId, "absent");
      assert.equal(f.calls.length, 1, "unknown IDs do not fall back or add configured providers");
    } finally { f.client.dispose(); }
  });

  it("uses the active model of a selected provider, otherwise its first registered model", async () => {
    const first = fakeModel({ ...deepseek, id: "first" });
    const selected = fakeModel({ ...deepseek, id: "selected" });
    const f = setup({ models: [first, selected] });
    try {
      f.select(selected);
      assert.equal(only(await f.client.read({ selection: { providers: ["deepseek"] } })).modelId, "selected");
      f.select(fakeModel({ ...deepseek, provider: "elsewhere" }));
      assert.equal(only(await f.client.read({ selection: { providers: ["deepseek"] } })).modelId, "first");
    } finally { f.client.dispose(); }
  });

  it("rejects malformed selections and unsafe read-time overrides without HTTP", async () => {
    const f = setup();
    const invalid = [
      { selection: {} }, { selection: { active: false } }, { selection: { providers: [] } },
      { selection: { models: [] } }, { selection: { providers: [""] } }, { selection: { providers: ["  "] } },
      { selection: { models: [{ provider: "deepseek", modelId: "" }] } },
      { selection: { active: true, providers: ["deepseek"] } },
      { selection: { providers: ["deepseek"], models: [{ provider: "deepseek", modelId: "chat" }] } },
      { selection: { providers: [3] } }, { refresh: "always" }, { url: "https://other.invalid/quota" },
      { credentials: "private" }, { concurrency: 999 }, { selection: null },
    ];
    try {
      for (const args of invalid) {
        await assert.rejects(async () => f.client.read(args as never), Error);
      }
      f.select(undefined);
      await assert.rejects(() => f.client.read(), Error);
      const noResolver = createUsageClient({ modelRegistry: f.registry, config: normalizeConfig({}), fetchImpl: sequenceFetch([balance()]).fetchImpl });
      try { await assert.rejects(() => noResolver.read({ selection: { active: true } }), Error); }
      finally { noResolver.dispose(); }
      assert.equal(f.calls.length, 0);
    } finally { f.client.dispose(); }
  });

  it("cached is HTTP-free and TTL/source/original timestamps survive cache delivery", async () => {
    const f = setup();
    try {
      const cold = only(await f.client.read({ refresh: "cached" }));
      assert.equal(cold.freshness, "missing"); assert.equal(cold.cacheHit, false);
      assert.equal(cold.observedAt, undefined); assert.equal(cold.source, undefined); assert.deepEqual(cold.metrics, []);
      assert.equal(f.calls.length, 0);
      const initial = only(await f.client.read());
      assert.equal(initial.cacheHit, false); assert.equal(initial.freshness, "fresh");
      assert.equal(initial.observedAt, NOW); assert.equal(initial.source, "http");
      f.advance(300_000);
      const edge = only(await f.client.read());
      assert.equal(edge.freshness, "fresh"); assert.equal(edge.cacheHit, true); assert.equal(f.calls.length, 1);
      f.advance(1);
      const staleReport = await f.client.read({ refresh: "cached" });
      const stale = only(staleReport);
      assert.equal(staleReport.generatedAt, NOW + 300_001);
      assert.equal(stale.freshness, "stale"); assert.equal(stale.source, "http");
      assert.equal(stale.observedAt, NOW); assert.equal(stale.cacheHit, true); assert.equal(f.calls.length, 1);
      assert.equal(only(await f.client.read()).observedAt, NOW + 300_001);
      assert.equal(f.calls.length, 2);
      await f.client.read({ refresh: "force" }); assert.equal(f.calls.length, 3);
      publicShape(staleReport);
    } finally { f.client.dispose(); }
  });

  for (const [delay, freshness] of [[1, "fresh"], [2, "stale"]] as const) {
    it(`evaluates aggregate freshness at report generation (${freshness} at TTL${delay === 1 ? "" : "+1"})`, async () => {
      const peer = fakeModel({ ...deepseek, provider: "peer", baseUrl: "https://peer.example/v1" });
      const gate = deferred();
      let peerStarted = false;
      const requests: string[] = [];
      const f = setup({ models: [deepseek, peer], rawConfig: { reportConcurrency: 1 },
        fetchImpl: (async (input) => {
          const host = new URL(String(input)).hostname;
          requests.push(host);
          if (host === "peer.example") {
            peerStarted = true;
            await gate.promise;
          }
          return balance();
        }) as typeof fetch });
      try {
        const initial = only(await f.client.read());
        assert.equal(initial.observedAt, NOW); assert.equal(initial.source, "http");
        assert.equal(initial.freshness, "fresh"); assert.equal(initial.cacheHit, false);
        f.advance(299_999);
        const pending = f.client.read({ selection: { providers: ["deepseek", "peer"] } });
        // Serial work ensures the first result was delivered from its cache
        // before the second provider starts; time then moves during collection.
        await until(() => peerStarted);
        f.advance(delay);
        gate.resolve();
        const report = await pending;
        assert.equal(report.generatedAt, NOW + 299_999 + delay);
        assert.deepEqual(report.results.map((r) => r.provider), ["deepseek", "peer"]);
        const cached = report.results[0]!;
        assert.equal(cached.freshness, freshness, "age is measured against the final report time, with an inclusive TTL");
        assert.equal(cached.observedAt, initial.observedAt);
        assert.equal(cached.source, initial.source); assert.equal(cached.cacheHit, true);
        assert.equal(cached.status, "ok"); assert.deepEqual(cached.metrics, initial.metrics);
        assert.equal(report.results[1]?.status, "ok");
        assert.equal(report.results[1]?.freshness, "fresh");
        assert.deepEqual(requests, ["api.deepseek.com", "peer.example"], "report completion does not re-request the early provider");
        for (const result of report.results) {
          if (result.freshness === "fresh") {
            assert.ok(result.observedAt !== undefined);
            assert.ok(report.generatedAt - result.observedAt <= 300_000);
          }
        }
        const text = formatUsageReport(report);
        if (freshness === "stale") assert.match(text, /\bstale\b/i);
        else assert.doesNotMatch(text, /\bstale\b/i);
        publicShape(report);
      } finally { gate.resolve(); f.client.dispose(); }
    });
  }

  for (const [httpStatus, status, delay] of [
    [401, "rejected", 1_800_000], [429, "rate-limited", 300_000],
    [503, "unavailable", 300_000], [500, "error", 60_000], [404, "unsupported", 1_800_000],
  ] as const) {
    it(`isolates HTTP ${httpStatus} as ${status} data and respects backoff`, async () => {
      const recorded = sequenceFetch([textResponse("PRIVATE_BODY", { status: httpStatus }), () => balance()]);
      const f = setup({ fetchImpl: recorded.fetchImpl });
      try {
        const failed = only(await f.client.read());
        assert.equal(failed.status, status);
        assert.ok(["rejected", "rate-limited", "unavailable", "error", "unsupported"].includes(failed.error?.code ?? ""));
        assert.equal(failed.nextRetryAt, NOW + delay); assert.equal(failed.freshness, "missing");
        assert.equal(failed.observedAt, undefined); assert.equal(failed.source, undefined);
        assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_BODY/);
        await f.client.read(); assert.equal(recorded.calls.length, 1);
        f.advance(delay - 1); await f.client.read(); assert.equal(recorded.calls.length, 1);
        f.advance(1); assert.equal(only(await f.client.read()).status, "ok");
        assert.equal(recorded.calls.length, 2);
      } finally { f.client.dispose(); }
    });
  }

  it("force bypasses main backoff but not optional endpoint Retry-After", async () => {
    const main = sequenceFetch([textResponse("private", { status: 429, headers: { "retry-after": "99999" } }), () => balance()]);
    const f = setup({ fetchImpl: main.fetchImpl });
    try {
      assert.equal(only(await f.client.read()).nextRetryAt, NOW + 3_600_000);
      assert.equal(only(await f.client.read({ refresh: "force" })).status, "ok");
      assert.equal(main.calls.length, 2);
    } finally { f.client.dispose(); }
    const openrouter = fakeModel({ provider: "openrouter", id: "chat", baseUrl: "https://openrouter.ai/api/v1" });
    let required = 0, optional = 0;
    const r = setup({ models: [openrouter], fetchImpl: (async (input) => {
      if (String(input).endsWith("/credits")) {
        optional++;
        return textResponse("PRIVATE_CREDITS", { status: 429, headers: { "retry-after": "600" } });
      }
      required++; return jsonResponse({ data: { limit: 20, limit_remaining: 15 } });
    }) as typeof fetch });
    try {
      const first = only(await r.client.read()); assert.equal(first.status, "ok");
      const budget = first.metrics.find((m) => m.kind === "budget")!;
      assert.equal(budget.scope, "key"); assert.equal(budget.limit, 20);
      assert.equal(budget.used, 5); assert.equal(budget.remaining, 15);
      await r.client.read({ refresh: "force" }); assert.equal(required, 2); assert.equal(optional, 1);
      r.advance(600_000); await r.client.read({ refresh: "force" }); assert.equal(optional, 2);
    } finally { r.client.dispose(); }
  });

  it("returns disabled before credential resolution even for force or missing models", async () => {
    const f = setup({ auth: () => { throw new Error("must not resolve disabled auth"); },
      rawConfig: { providers: { deepseek: { enabled: false }, absent: { enabled: false } } } });
    try {
      const report = await f.client.read({ selection: { providers: ["deepseek", "absent"] }, refresh: "force" });
      assert.deepEqual(report.results.map((r) => r.status), ["disabled", "disabled"]);
      for (const r of report.results) {
        assert.equal(r.freshness, "missing"); assert.deepEqual(r.metrics, []);
        assert.equal(r.observedAt, undefined); assert.equal(r.source, undefined);
      }
      assert.equal(f.calls.length, 0);
    } finally { f.client.dispose(); }
  });

  it("reports missing credentials, unsupported API keys and thrown provider errors as data", async () => {
    const openai = fakeModel({ provider: "openai", id: "chat", baseUrl: "https://api.openai.com/v1" });
    const broken = fakeModel({ ...deepseek, provider: "broken" });
    const f = setup({ models: [deepseek, openai, broken], auth: (model) => model.provider === "broken"
      ? { throws: "PRIVATE_RESOLVER https://private.invalid/?token=secret" }
      : model.provider === "deepseek" ? { ok: false, error: "PRIVATE_MISSING" } : { apiKey: "synthetic-key" } });
    try {
      const report = await f.client.read({ selection: { providers: ["deepseek", "openai", "broken"] } });
      assert.deepEqual(report.results.map((r) => r.status), ["no-credential", "unsupported", "no-credential"]);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private\.invalid|synthetic-key/);
      assert.equal(f.calls.length, 0); publicShape(report);
    } finally { f.client.dispose(); }
  });

  it("preserves normalized unknowns, over-allocation, elapsed resets and real zero/negative balances", async () => {
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://proxy.example/v1" });
    const recorded = sequenceFetch([quota()]);
    const f = setup({ models: [cpa], fetchImpl: recorded.fetchImpl });
    try {
      const report = await f.client.read(); const r = only(report);
      const window = r.metrics.find((m) => m.kind === "subscription-window")!;
      assert.equal(r.metrics.length, 1); assert.equal(window.usedPercent, 140);
      assert.equal(window.resetAtSeconds, NOW / 1000 - 60);
      for (const field of ["durationSeconds", "limit", "used", "remaining", "remainingPercent"]) {
        assert.equal(Object.hasOwn(window, field), false, `${field} must remain omitted`);
      }
      assert.match(formatUsageReport(report), /140%/);
      assert.match(formatUsageReport(report), /elapsed/i); publicShape(report);
    } finally { f.client.dispose(); }
    const b = setup({ fetchImpl: (async () => jsonResponse({ balance_infos: [
      { currency: "USD", total_balance: "0", granted_balance: "0" },
      { currency: "CNY", total_balance: "-2" },
    ] })) as typeof fetch });
    try {
      const report = await b.client.read(); const metrics = only(report).metrics;
      assert.deepEqual(metrics.map((m) => m.remaining), [0, -2]);
      assert.equal(metrics[0]?.breakdown?.[0]?.value, 0); publicShape(report);
    } finally { b.client.dispose(); }
  });

  it("keeps subscription, request, token and unlimited-status dimensions distinct", async () => {
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://proxy.example/v1" });
    const f = setup({ models: [model], fetchImpl: (async () => jsonResponse({
      rate_limit: { secondary_window: { used_percent: 0, limit_window_seconds: 604800 } },
      credits: { unlimited: true },
    }, { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25",
      "x-ratelimit-remaining-tokens": "500" } })) as typeof fetch });
    try {
      const report = await f.client.read(); const metrics = only(report).metrics;
      assert.deepEqual(metrics.map((m) => m.kind).sort(), ["request-limit", "status", "subscription-window", "token-limit"]);
      assert.equal(metrics.find((m) => m.kind === "subscription-window")?.durationSeconds, 604800);
      assert.equal(metrics.find((m) => m.kind === "subscription-window")?.usedPercent, 0);
      assert.equal(metrics.find((m) => m.kind === "status")?.status, "unlimited");
      const tokens = metrics.find((m) => m.kind === "token-limit")!;
      assert.equal(tokens.remaining, 500);
      for (const field of ["limit", "used", "usedPercent"]) assert.equal(Object.hasOwn(tokens, field), false);
      publicShape(report);
    } finally { f.client.dispose(); }
  });

  it("whitelists DTOs and removes private echoes and controls from all remote/config text", async () => {
    const secret = "SYNTHETIC_PRIVATE_CREDENTIAL";
    const account = "SYNTHETIC_PRIVATE_ACCOUNT";
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://private-origin.example/v1" });
    const f = setup({ models: [cpa], auth: { apiKey: secret, headers: { "ChatGPT-Account-Id": account } },
      rawConfig: { providers: { cpa: { scheme: `invalid-${secret}\u001b[31m` } } },
      fetchImpl: (async () => jsonResponse({
        plan_type: `plan-${secret}-${account}-https://private-origin.example\u001b[31m\u202e`,
        quota_mode: `mode-${secret}`,
        account_id: account, raw: { authorization: secret },
        rate_limit: { secondary_window: { used_percent: 42 } },
        balance_infos: [{ currency: `${secret}\u001b[31m`, total_balance: "7" }],
      })) as typeof fetch });
    try {
      const report = await f.client.read(); publicShape(report);
      const serialized = JSON.stringify(report);
      assert.doesNotMatch(serialized, /SYNTHETIC_PRIVATE_|private-origin|\\u001b|\\u202e/i);
      assert.doesNotMatch(formatUsageReport(report), /SYNTHETIC_PRIVATE_|private-origin|[\u001b\u202e]/);
    } finally { f.client.dispose(); }
    // DeepSeek uses remote currency text in IDs, labels and units.
    const d = setup({ auth: { apiKey: secret }, fetchImpl: (async () => jsonResponse({
      balance_infos: [{ currency: `${secret}\u001b[31m\u202e`, total_balance: "7", granted_balance: "2" }],
    })) as typeof fetch });
    try {
      const report = await d.client.read(); publicShape(report);
      assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE_|\\u001b|\\u202e/i);
    } finally { d.client.dispose(); }
  });

  for (const fixture of shortRoutingPrivacyCases()) {
    it(`redacts ${fixture.name} without altering numeric measurements`, async () => {
      const recorded = sequenceFetch([() => jsonResponse(fixture.body)]);
      const f = setup({ models: [fixture.model], auth: fixture.auth, rawConfig: fixture.config, fetchImpl: recorded.fetchImpl });
      try {
        for (const refresh of ["if-needed", "cached"] as const) {
          const report = await f.client.read({ refresh });
          const result = only(report);
          assert.equal(result.status, "ok"); assert.equal(result.source, "http");
          assert.equal(result.cacheHit, refresh === "cached");
          assert.equal(result.metrics.length, 1, "privacy must not discard usable quota data");
          assert.equal(result.metrics[0]?.usedPercent, fixture.usedPercent);
          assert.equal(result.metrics[0]?.resetAtSeconds, fixture.resetAtSeconds);
          if (fixture.scheme === "codex-json") {
            assert.match(result.notice ?? "", /plan=/); assert.match(result.notice ?? "", /quota_mode=/);
          } else {
            assert.match(result.metrics[0]?.scope ?? "", /^model:/);
          }
          // Numbers may legitimately equal the private identifier. Only public
          // strings must redact it, including IDs, labels, scopes and notices.
          const strings = JSON.stringify(report, (_key, value: unknown) => typeof value === "number" ? undefined : value);
          assert.equal(strings.includes(fixture.privateValue), false, "no resolved private value may survive in DTO strings");
          const text = formatUsageReport(report);
          for (const echo of fixture.echoes) assert.equal(text.includes(echo), false, "formatting must not restore a private echo");
          assert.match(text, new RegExp(`${fixture.usedPercent}%`), "formatting preserves the numeric measurement");
          publicShape(report);
        }
        assert.equal(recorded.calls.length, 1);
        assert.equal(recorded.calls[0]?.headers[fixture.headerName.toLowerCase()], fixture.privateValue);
      } finally { f.client.dispose(); }
    });
  }

  it("omits arbitrary invalid scheme values without relying on resolved credentials or quote boundaries", async () => {
    for (const invalidScheme of [
      'bad"PRIVATE_CONFIG_DOUBLE_SUFFIX',
      'bad"PRIVATE_CONFIG_QUOTED_SUFFIX"tail',
      'bad\\"PRIVATE_CONFIG_ESCAPED_SUFFIX',
      "bad-PRIVATE_CONFIG_UNRELATED_VALUE",
    ]) {
      let resolutions = 0;
      const f = setup({ models: [],
        auth: () => { resolutions++; throw new Error("an unresolved provider has no credentials"); },
        rawConfig: { providers: { unresolved: { scheme: invalidScheme } } } });
      try {
        const report = await f.client.read({ selection: { providers: ["unresolved"] } });
        assert.equal(only(report).status, "unknown");
        assert.ok(report.configProblems.some((problem) => /scheme/i.test(problem)), "retain a useful configuration diagnostic");
        publicShape(report);
        for (const output of [JSON.stringify(report), formatUsageReport(report)]) {
          assert.equal(output.includes(invalidScheme), false);
          assert.doesNotMatch(output, /PRIVATE_CONFIG_/u, "no private suffix may survive an embedded delimiter");
        }
        assert.equal(resolutions, 0); assert.equal(f.calls.length, 0);
      } finally { f.client.dispose(); }
    }
  });

  it("preserves safe model scopes and declared durations while sanitizing private metric dimensions", async () => {
    const account = "SYNTHETIC_PRIVATE_ACCOUNT";
    const model = fakeModel({ provider: "anthropic", id: "claude", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" });
    const f = setup({ models: [model], auth: { apiKey: "sk-ant-oat-synthetic", isOAuth: true,
      headers: { "x-routing-account": account } }, fetchImpl: (async () => jsonResponse({
      five_hour: { utilization: 20 }, seven_day_opus: { utilization: 30 },
      [`seven_day_${account}\u001b[31m\u202e`]: { utilization: 40 },
    })) as typeof fetch });
    try {
      const report = await f.client.read(); const metrics = only(report).metrics;
      assert.equal(metrics.find((m) => m.durationSeconds === 18_000)?.usedPercent, 20);
      assert.equal(metrics.find((m) => m.scope === "model:opus")?.usedPercent, 30);
      assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE_|\\u001b|\\u202e/i);
      publicShape(report);
    } finally { f.client.dispose(); }
  });

  it("enforces bounded authenticated GETs, redirect refusal, unsafe URL and body caps through the API", async () => {
    for (const response of [
      textResponse("redirect-private", { status: 302, headers: { location: "https://attacker.invalid/quota" } }),
      textResponse("x".repeat(2048)),
    ]) {
      let calls = 0;
      const f = setup({ rawConfig: { maxBodyBytes: 1024 }, fetchImpl: (async (_input, init) => {
        calls++; assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-key");
        assert.ok(init?.signal instanceof AbortSignal);
        return response;
      }) as typeof fetch });
      try {
        const report = await f.client.read();
        assert.notEqual(only(report).status, "ok"); assert.equal(calls, 1);
        assert.doesNotMatch(JSON.stringify(report), /attacker|redirect-private|synthetic-key/);
      } finally { f.client.dispose(); }
    }
    const unsafe = setup({ models: [fakeModel({ ...deepseek, baseUrl: "https://user:PRIVATE_PASSWORD@private.example/v1" })] });
    try {
      const report = await unsafe.client.read(); assert.equal(only(report).status, "unsupported");
      assert.equal(unsafe.calls.length, 0); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PASSWORD|private\.example/);
    } finally { unsafe.client.dispose(); }
  });

  it("does not let a late old-account response replace the current account cache", async () => {
    let key = "key-a", started = false;
    const gate = deferred();
    const f = setup({ auth: () => ({ apiKey: key }), fetchImpl: (async (_input, init) => {
      if (new Headers(init?.headers).get("authorization") === "Bearer key-a") {
        started = true; await gate.promise; return balance("11");
      }
      return balance("22");
    }) as typeof fetch });
    try {
      const old = f.client.read(); await until(() => started);
      key = "key-b";
      assert.equal(only(await f.client.read()).metrics[0]?.remaining, 22);
      gate.resolve(); await old;
      const cached = only(await f.client.read({ refresh: "cached" }));
      assert.equal(cached.metrics[0]?.remaining, 22); assert.equal(cached.cacheHit, true);
    } finally { gate.resolve(); f.client.dispose(); }
  });

  it("re-resolves credentials/routes before cached delivery and never reuses another account", async () => {
    let key = "key-a", route = "route-a", baseUrl = deepseek.baseUrl;
    let suppressed = false;
    const recorded = sequenceFetch([() => balance("11"), () => balance("22"), () => balance("33"), () => balance("44")]);
    const f = setup({ fetchImpl: recorded.fetchImpl,
      auth: () => ({ apiKey: key, baseUrl, headers: { "x-routing": route, ...(suppressed ? { Authorization: null } : {}) } }) });
    try {
      assert.equal(only(await f.client.read()).metrics[0]?.remaining, 11);
      for (const change of [() => { key = "key-b"; }, () => { route = "route-b"; },
        () => { baseUrl = "https://new-route.example/v1"; }, () => { suppressed = true; }]) {
        const before = recorded.calls.length; change();
        const cached = only(await f.client.read({ refresh: "cached" }));
        assert.equal(cached.freshness, "missing"); assert.deepEqual(cached.metrics, []);
        assert.equal(recorded.calls.length, before, "cache-only still performs no HTTP");
        await f.client.read(); assert.equal(recorded.calls.length, before + 1);
      }
      assert.equal(recorded.calls[1]?.headers.authorization, "Bearer key-b");
      assert.equal(recorded.calls[2]?.headers["x-routing"], "route-b");
      assert.match(recorded.calls[3]?.url ?? "", /^https:\/\/new-route\.example/);
      assert.equal(recorded.calls[4]?.headers.authorization, undefined);
    } finally { f.client.dispose(); }
  });

  it("binds selection before awaited auth, without replacing a pending read's model", async () => {
    const authGate = deferred(); let authStarted = false;
    const peer = fakeModel({ ...deepseek, provider: "peer", id: "peer-chat", baseUrl: "https://peer.example/v1" });
    const f = setup({ models: [deepseek, peer], auth: (model) => {
      if (model.provider === "deepseek") { authStarted = true; return { apiKey: "key-a", wait: authGate.promise }; }
      return { apiKey: "key-b" };
    } });
    try {
      const pending = f.client.read(); await until(() => authStarted);
      f.select(peer); authGate.resolve();
      assert.equal(only(await pending).provider, "deepseek");
      assert.equal(only(await f.client.read()).provider, "peer");
    } finally { authGate.resolve(); f.client.dispose(); }
  });

  for (const cancelledCaller of ["owner", "joiner"] as const) {
    it(`cancels only the ${cancelledCaller}'s wait, preserving shared account work and cache`, async () => {
      const gate = deferred(); let requests = 0; let requestSignal: AbortSignal | null | undefined;
      const alternate = fakeModel({ ...deepseek, id: "other-model" });
      const f = setup({ models: [deepseek, alternate], fetchImpl: (async (_input, init) => {
        requests++; requestSignal = init?.signal; await gate.promise; return balance("9");
      }) as typeof fetch });
      try {
        const controller = new AbortController();
        const owner = f.client.read({ ...(cancelledCaller === "owner" ? { signal: controller.signal } : {}) });
        await until(() => requests === 1);
        const joiner = f.client.read({ selection: { models: [{ provider: "deepseek", modelId: "other-model" }] },
          ...(cancelledCaller === "joiner" ? { signal: controller.signal } : {}) });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const cancelled = cancelledCaller === "owner" ? owner : joiner;
        const rejected = assert.rejects(cancelled, (error: unknown) => {
          assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /PRIVATE_ABORT_REASON/);
          return abortError(error);
        });
        controller.abort(new Error("PRIVATE_ABORT_REASON"));
        await rejected;
        assert.equal(requestSignal?.aborted, false, "another caller still owns its wait");
        gate.resolve();
        const survivor = only(await (cancelledCaller === "owner" ? joiner : owner));
        assert.equal(survivor.status, "ok"); assert.equal(survivor.metrics[0]?.remaining, 9);
        assert.equal(requests, 1);
        const cached = only(await f.client.read({ refresh: "cached" }));
        assert.equal(cached.metrics[0]?.remaining, 9); assert.equal(cached.observedAt, NOW);
      } finally { gate.resolve(); f.client.dispose(); }
    });
  }

  it("bounds concurrent providers, includes all selections in order and isolates network failures", async () => {
    const models = Array.from({ length: 6 }, (_, i) => fakeModel({ provider: `p${i}`, id: "chat", baseUrl: `https://p${i}.example/v1` }));
    const releases = Array.from({ length: 6 }, () => deferred());
    const started: number[] = []; let running = 0, maximum = 0;
    const f = setup({ models, rawConfig: { reportConcurrency: 2, maxDiscoveryRequests: 1 }, fetchImpl: (async (input) => {
      const index = Number(new URL(String(input)).hostname.slice(1, 2));
      started.push(index); maximum = Math.max(maximum, ++running);
      try {
        await releases[index]!.promise;
        if (index === 1) throw new Error("PRIVATE_NETWORK_EXCEPTION");
        return quota(index);
      } finally { running--; }
    }) as typeof fetch });
    try {
      const reportPromise = f.client.read({ selection: { providers: models.map((m) => m.provider) } });
      await until(() => started.length === 2);
      assert.equal(running, 2); releases[1]!.resolve();
      await until(() => started.length === 3);
      for (const gate of releases) gate.resolve();
      const report = await reportPromise;
      assert.equal(maximum, 2); assert.equal(started.length, 6);
      assert.deepEqual(report.results.map((r) => r.provider), models.map((m) => m.provider));
      assert.equal(report.results[1]?.status, "error");
      assert.ok(report.results.filter((r) => r.status === "ok").length === 5);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_NETWORK_EXCEPTION/);
    } finally { for (const gate of releases) gate.resolve(); f.client.dispose(); }
  });

  it("handles already aborted reads and disposal during HTTP and late auth without reviving work", async () => {
    const early = setup();
    try {
      await assert.rejects(() => early.client.read({ signal: AbortSignal.abort("PRIVATE_REASON") }), abortError);
      assert.equal(early.calls.length, 0);
    } finally { early.client.dispose(); }
    const gate = deferred(); let signal: AbortSignal | null | undefined; let reached = false;
    const f = setup({ fetchImpl: (async (_input, init) => { signal = init?.signal; reached = true; await gate.promise; return balance(); }) as typeof fetch });
    const pending = f.client.read(); const rejection = assert.rejects(pending, Error);
    await until(() => reached); f.client.dispose(); f.client.dispose();
    await rejection; assert.equal(signal?.aborted, true); gate.resolve();
    await assert.rejects(() => f.client.read(), Error); assert.throws(() => f.client.listProviders(), Error);
    const authGate = deferred(); let authReached = false;
    const a = setup({ auth: () => { authReached = true; return { apiKey: "key", wait: authGate.promise }; } });
    const delayed = a.client.read(); const delayedRejection = assert.rejects(delayed, Error);
    await until(() => authReached); a.client.dispose(); await delayedRejection;
    authGate.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(a.calls.length, 0);
  });

  it("returns detached DTOs and formats purely from report time without output or mutation", async () => {
    const f = setup();
    try {
      const first = await f.client.read(); first.results[0]!.metrics[0]!.remaining = 999;
      assert.equal(only(await f.client.read({ refresh: "cached" })).metrics[0]?.remaining, 7);
      const report: UsageReport = { schemaVersion: 1, generatedAt: NOW, configProblems: [], results: [{
        provider: "cpa\u001b[31m", modelId: "chat", status: "ok", freshness: "fresh", cacheHit: false,
        observedAt: NOW, source: "http", metrics: [{ id: "window", kind: "subscription-window", label: "weekly\u202e",
          usedPercent: 140, resetAtSeconds: NOW / 1000 - 60, source: "codex-json" }],
      }] };
      Object.assign(report.results[0]!, { identity: { key: "PRIVATE_TARGET_KEY", origin: "https://private.invalid" },
        headers: { authorization: "PRIVATE_AUTH" } });
      const serialized = JSON.stringify(report); const text = formatUsageReport(report);
      f.advance(86_400_000);
      assert.equal(formatUsageReport(report), text); assert.equal(JSON.stringify(report), serialized);
      assert.match(text, /140%/); assert.match(text, /elapsed/i);
      assert.doesNotMatch(text, /[\u001b\u202e]|PRIVATE_|private\.invalid/);
    } finally { f.client.dispose(); }
  });
});
