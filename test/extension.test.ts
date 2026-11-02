import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeConfig } from "../src/config.ts";
import { COMMAND_NAME, REPORT_WIDGET_KEY, UniversalUsageHost } from "../src/extension.ts";
import { UsageMonitor } from "../src/monitor.ts";
import { fakeModel, fakeRegistry, jsonResponse, sequenceFetch, textResponse, type FakeAuth } from "./helpers.ts";

type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
  entries: Array<{ type: string; data: unknown }>;
  emit(event: string, payload: unknown, ctx: unknown): Promise<void>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const api = {
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      commands.set(name, options);
    },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    handlers,
    commands,
    entries,
    async emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

interface FakeContext {
  ctx: ExtensionContext;
  statuses: Array<string | undefined>;
  widgets: Array<{ key: string; lines: string[] | undefined }>;
  notifications: string[];
}

function fakeContext(options: {
  model?: ReturnType<typeof fakeModel>;
  /** Live selection read through a `model` getter, for silent same-ID route changes. */
  modelRef?: { current: ReturnType<typeof fakeModel> };
  registry: unknown;
  mode?: "tui" | "print" | "rpc" | "json";
  hasUI?: boolean;
  idle?: boolean;
}): FakeContext {
  const statuses: Array<string | undefined> = [];
  const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
  const notifications: string[] = [];
  const ctx = {
    ui: {
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text);
      },
      setWidget(key: string, lines: string[] | undefined) {
        widgets.push({ key, lines });
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    model: options.model,
    modelRegistry: options.registry,
    isIdle: () => options.idle ?? true,
    cwd: "/tmp",
    simpleStream: undefined,
  } as unknown as ExtensionContext;
  if (options.modelRef !== undefined) {
    // Pi exposes the selection as a live getter, so an unreported same-ID
    // replacement is observable without a model_select event.
    Object.defineProperty(ctx, "model", { get: () => options.modelRef?.current, enumerable: true, configurable: true });
  }
  return { ctx, statuses, widgets, notifications };
}

function statusOf(model: ReturnType<typeof fakeModel>) {
  return {
    apiKey: "test-key",
    baseUrl: model.baseUrl,
  };
}

function codexBody(usedPercent: number) {
  return jsonResponse({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: null,
      secondary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_after_seconds: 60 },
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function buildHost(options: {
  fetchImpl: typeof fetch;
  models: Array<ReturnType<typeof fakeModel>>;
  timers?: boolean;
  config?: ReturnType<typeof normalizeConfig>;
  auth?: (model: ReturnType<typeof fakeModel>) => FakeAuth;
}) {
  const pi = fakePi();
  const registry = fakeRegistry(
    options.auth ?? ((model) => statusOf(model as ReturnType<typeof fakeModel>)),
    options.models,
  );
  let now = 1_768_000_000_000;
  const monitor = new UsageMonitor({ now: () => now, fetchImpl: options.fetchImpl, policy: { timeoutMs: 200 } });
  const host = new UniversalUsageHost(pi.api, {
    monitor,
    now: () => now,
    config: options.config ?? normalizeConfig({ refreshSeconds: 300 }),
    timers: options.timers ?? true,
  });
  host.register();
  return {
    pi,
    registry,
    host,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("pi extension wiring", () => {
  it("registers the command and lifecycle handlers without opening a connection", () => {
    const { fetchImpl, calls } = sequenceFetch([jsonResponse({})]);
    const { pi } = buildHost({
      fetchImpl,
      models: [fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" })],
    });
    assert.ok(pi.commands.has(COMMAND_NAME));
    for (const event of ["session_start", "model_select", "turn_start", "agent_end", "after_provider_response", "session_shutdown"]) {
      assert.equal(pi.handlers.get(event)?.length, 1);
    }
    assert.equal(calls.length, 0);
  });

  it("refreshes on session start and paints the compact footer", async () => {
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "7.50" }] }),
    ]);
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => fake.statuses.length > 0 && fake.statuses[fake.statuses.length - 1] !== undefined && !String(fake.statuses[fake.statuses.length - 1]).includes("checking"));
    assert.equal(calls.length, 1);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /deepseek/);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /USD \$7\.5/);
    host.shutdown(fake.ctx);
  });

  it("does not paint an old provider's late result after a model switch", async () => {
    let releaseA: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("a.example.com")) {
        await gate;
        return codexBody(11);
      }
      return codexBody(22);
    }) as typeof fetch;
    const modelA = fakeModel({ provider: "provider-a", id: "chat-a", baseUrl: "https://a.example.com/v1" });
    const modelB = fakeModel({ provider: "provider-b", id: "chat-b", baseUrl: "https://b.example.com/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB] });
    // Pi installs the new selection before it emits model_select, so the live
    // getter already reads modelB when the handler runs.
    const selection = { current: modelA };
    const fakeA = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fakeA.ctx);
    await waitFor(() => fakeA.statuses.length > 0);

    selection.current = modelB;
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fakeA.ctx);
    const afterSwitch = fakeA.statuses[fakeA.statuses.length - 1];
    assert.match(String(afterSwitch), /provider-b/);
    assert.match(String(afterSwitch), /22%/);

    releaseA?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(String(fakeA.statuses[fakeA.statuses.length - 1]), /provider-b/);
    assert.doesNotMatch(String(fakeA.statuses[fakeA.statuses.length - 1]), /provider-a/);
    host.shutdown(fakeA.ctx);
  });

  it("completes a report when a later same-identity resolution is still pending", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const { fetchImpl, calls: requests } = sequenceFetch([codexBody(22)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("model_select", { model }, fake.ctx);
    let calls = 0;
    const resolve = registry.getApiKeyAndHeaders.bind(registry);
    registry.getApiKeyAndHeaders = async (selected) => {
      const gate = ++calls === 1 ? firstGate : secondGate;
      await gate;
      return resolve(selected);
    };
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const report = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls >= 1);
    const later = host.refreshActive(fake.ctx, { force: true });
    await waitFor(() => calls >= 2);
    releaseFirst();
    await report;
    assert.equal(requests.length, 1);
    assert.match((fake.widgets.at(-1)?.lines ?? []).join("\n"), /cpa\/chat[\s\S]*22%/);
    releaseSecond();
    await later;
    host.shutdown(fake.ctx);
  });

  it("keeps an in-flight report when reselection adopts the same rotated identity", async () => {
    let releaseReport!: () => void;
    let releaseReselect!: () => void;
    let releaseFetch!: () => void;
    const reportGate = new Promise<void>((resolve) => { releaseReport = resolve; });
    const reselectGate = new Promise<void>((resolve) => { releaseReselect = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let key = "key-a";
    let fetchStarted = false;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer key-b");
      fetchStarted = true;
      await fetchGate;
      return codexBody(22);
    }) as typeof fetch;
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], auth: () => ({ apiKey: key }) });
    const fake = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("model_select", { model }, fake.ctx);
    key = "key-b";
    let resolutions = 0;
    const resolve = registry.getApiKeyAndHeaders.bind(registry);
    registry.getApiKeyAndHeaders = async (selected) => {
      const gate = ++resolutions === 1 ? reportGate : reselectGate;
      await gate;
      return resolve(selected);
    };
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const report = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => resolutions === 1);
    const reselect = pi.emit("model_select", { model }, fake.ctx);
    await waitFor(() => resolutions === 2);
    releaseReport();
    await waitFor(() => fetchStarted);
    releaseReselect();
    await reselect;
    releaseFetch();
    await report;
    assert.match((fake.widgets.at(-1)?.lines ?? []).join("\n"), /cpa\/chat[\s\S]*22%/);
    assert.match(String(fake.statuses.at(-1)), /22%/);
    host.shutdown(fake.ctx);
  });

  it("invalidates a newly adopted identity when a pending reselection fails", async () => {
    let releaseReport!: () => void;
    let releaseReselect!: () => void;
    let releaseFetch!: () => void;
    const reportGate = new Promise<void>((resolve) => { releaseReport = resolve; });
    const reselectGate = new Promise<void>((resolve) => { releaseReselect = resolve; });
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let key: string | undefined;
    let fetchStarted = false;
    const fetchImpl = (async () => {
      fetchStarted = true;
      await fetchGate;
      return codexBody(22);
    }) as typeof fetch;
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], auth: () => key === undefined ? {} : { apiKey: key } });
    const fake = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("model_select", { model }, fake.ctx);
    key = "key-b";
    let resolutions = 0;
    const resolve = registry.getApiKeyAndHeaders.bind(registry);
    registry.getApiKeyAndHeaders = async (selected) => {
      if (++resolutions === 1) {
        await reportGate;
        return resolve(selected);
      }
      await reselectGate;
      return { ok: false, error: "credential removed" };
    };
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const report = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => resolutions === 1);
    const reselect = pi.emit("model_select", { model }, fake.ctx);
    await waitFor(() => resolutions === 2);
    releaseReport();
    await waitFor(() => fetchStarted);
    releaseReselect();
    await reselect;
    releaseFetch();
    await report;
    assert.match(String(fake.statuses.at(-1)), /no-credential/);
    assert.doesNotMatch((fake.widgets.at(-1)?.lines ?? []).join("\n"), /22%/);
    host.shutdown(fake.ctx);
  });

  it("ignores a delayed old credential resolution after a newer identity is adopted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let key = "key-a";
    let holding = false;
    let started = false;
    const auth = (): FakeAuth => {
      if (holding) {
        started = true;
        return { apiKey: key, wait: gate };
      }
      return { apiKey: key };
    };
    const { fetchImpl, calls } = sequenceFetch([codexBody(22)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], auth });
    const fake = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("model_select", { model }, fake.ctx);
    holding = true;
    const older = host.refreshActive(fake.ctx, { force: true });
    await waitFor(() => started);
    holding = false;
    key = "key-b";
    assert.equal((await host.refreshActive(fake.ctx, { force: true }))?.metrics[0]?.usedPercent, 22);
    release();
    assert.equal(await older, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.authorization, "Bearer key-b");
    assert.match(String(fake.statuses.at(-1)), /22%/);
    host.shutdown(fake.ctx);
  });

  it("replaces an old account in a report waiting on another provider", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let peerStarted = false;
    let key = "key-a";
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const peer = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        peerStarted = true;
        await gate;
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      return codexBody(new Headers(init?.headers).get("authorization") === "Bearer key-a" ? 11 : 22);
    }) as typeof fetch;
    const { pi, host, registry } = buildHost({
      fetchImpl, models: [cpa, peer], auth: () => ({ apiKey: key }),
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const fake = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { model: cpa }, fake.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const report = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => peerStarted);
    key = "key-b";
    await host.refreshActive(fake.ctx, { force: true });
    release();
    await report;
    const text = (fake.widgets.at(-1)?.lines ?? []).join("\n");
    assert.match(text, /22%/);
    assert.doesNotMatch(text, /11%/);
    assert.match(text, /deepseek\/chat/);
    host.shutdown(fake.ctx);
  });

  it("does not publish a delayed refresh after credentials rotate on the same selection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    let key = "key-a";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer key-a") {
        started = true;
        await gate;
        return codexBody(11);
      }
      assert.equal(authorization, "Bearer key-b");
      return codexBody(22);
    }) as typeof fetch;
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], auth: () => ({ apiKey: key }) });
    const fake = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("model_select", { model }, fake.ctx);
    const pending = host.refreshActive(fake.ctx, { force: true });
    await waitFor(() => started);
    key = "key-b";
    const newer = await host.refreshActive(fake.ctx, { force: true });
    assert.equal(newer?.metrics[0]?.usedPercent, 22);
    assert.match(String(fake.statuses.at(-1)), /22%/);
    release();
    assert.equal(await pending, undefined);
    assert.match(String(fake.statuses.at(-1)), /22%/);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    assert.match((fake.widgets.at(-1)?.lines ?? []).join("\n"), /22%/);
    host.shutdown(fake.ctx);
  });

  it("applies passive response headers only while a turn is in flight", async () => {
    const { fetchImpl } = sequenceFetch([codexBody(5)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const idle = fakeContext({ model, registry, idle: true });
    await pi.emit("model_select", { type: "model_select", model, previousModel: undefined, source: "set" }, idle.ctx);
    // A fresh endpoint snapshot wins over headers while idle.
    await pi.emit("after_provider_response", { status: 200, headers: { "x-codex-secondary-used-percent": "90" } }, idle.ctx);
    assert.doesNotMatch(String(idle.statuses[idle.statuses.length - 1]), /90%/);

    // An API-key OpenAI model has no quota endpoint, so response headers are
    // its only source. A turn boundary is required for sound attribution.
    const busyModel = fakeModel({ provider: "openai", id: "chat", baseUrl: "https://api.openai.com/v1" });
    const busy = fakeContext({ model: busyModel, registry, idle: false });
    await pi.emit("model_select", { type: "model_select", model: busyModel, previousModel: undefined, source: "set" }, busy.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, busy.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "250" } },
      busy.ctx,
    );
    assert.match(String(busy.statuses[busy.statuses.length - 1]), /req 75%/);
    host.shutdown(idle.ctx);
  });

  it("reports a passive-only measurement from /usage when no endpoint is requestable", async () => {
    const { fetchImpl, calls } = sequenceFetch([textResponse("unexpected request")]);
    const model = fakeModel({ provider: "openai", id: "chat", baseUrl: "https://api.openai.com/v1" });
    const { pi, host, registry, advance } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry, idle: false });
    await pi.emit("model_select", { type: "model_select", model, previousModel: undefined, source: "set" }, fake.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      fake.ctx,
    );
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /req 75%/);
    advance(120_000);

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    assert.equal(calls.length, 0);

    // The forced report keeps the header-derived value instead of erasing it.
    const footer = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(footer, /req 75%/);
    assert.doesNotMatch(footer, /no quota interface/);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /openai\/chat/);
    assert.match(text, /state: ok \[rate-limit-headers\] \(source: headers\)/);
    assert.match(text, /requests 75%/);
    // The original measurement timestamp is preserved, not reset by the command.
    assert.match(text, /age: 2m/);
    host.shutdown(fake.ctx);
  });

  it("writes a detailed report to the widget with the configured providers", async () => {
    const { fetchImpl } = sequenceFetch([
      jsonResponse({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 }, secondary_window: null } }),
    ]);
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const pi = fakePi();
    const registry = fakeRegistry((model) => statusOf(model as ReturnType<typeof fakeModel>), [cpa, deepseek]);
    const fetchImplWithBalance = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.deepseek.com")) {
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const host = new UniversalUsageHost(pi.api, {
      monitor: new UsageMonitor({ now: () => 1_768_000_000_000, fetchImpl: fetchImplWithBalance, policy: { timeoutMs: 200 } }),
      now: () => 1_768_000_000_000,
      loadConfig: () => normalizeConfig({ providers: { deepseek: { enabled: true } } }),
      timers: false,
    });
    host.register();
    const fake = fakeContext({ model: cpa, registry });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, fake.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    const widget = fake.widgets[fake.widgets.length - 1];
    assert.equal(widget?.key, REPORT_WIDGET_KEY);
    const text = (widget?.lines ?? []).join("\n");
    assert.match(text, /cpa\/chat/);
    assert.match(text, /deepseek\/chat/);
    assert.match(text, /balance \(USD\)/);
    assert.equal(fake.notifications.length, 1);
    host.shutdown(fake.ctx);
  });

  it("renders the report instead of rejecting when a configured path is malformed", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(20)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const config = normalizeConfig({ providers: { cpa: { path: "/wham/usage" } } });
    // Simulate a path that reached planning despite configuration validation.
    config.providers.set("cpa", { path: "//%", pathMode: "origin" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], config });
    const fake = fakeContext({ model, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /cpa\/chat/);
    assert.match(text, /state: unsupported/);
    assert.match(text, /could not be resolved to a valid URL/);
    assert.equal(calls.length, 0);
    host.shutdown(fake.ctx);
  });

  it("reports every configured provider beyond five", async () => {
    const models = ["prov1", "prov2", "prov3", "prov4", "prov5", "prov6"].map((provider) =>
      fakeModel({ provider, id: "chat", baseUrl: `https://${provider}.example.com/v1` }),
    );
    const { fetchImpl, calls } = sequenceFetch([codexBody(15)]);
    const config = normalizeConfig({
      providers: Object.fromEntries(models.map((model) => [model.provider, { enabled: true }])),
    });
    const { pi, host, registry } = buildHost({ fetchImpl, models, config });
    const fake = fakeContext({ model: models[0], registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    for (const model of models) assert.match(text, new RegExp(`${model.provider}/chat`));
    assert.equal(calls.length, models.length);
    host.shutdown(fake.ctx);
  });

  it("stops a report whose non-active provider credential resolves after a model switch", async () => {
    const { fetchImpl } = sequenceFetch([codexBody(10)]);
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const other = fakeModel({ provider: "other", id: "chat", baseUrl: "https://other.example.com/v1" });
    let holdDeepseek = false;
    let heldStarted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.provider === "deepseek" && holdDeepseek) {
        heldStarted = true;
        return { apiKey: "test-key", baseUrl: model.baseUrl, wait: gate };
      }
      return statusOf(model);
    };
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek, other],
      auth,
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const nonTuiSelection = { current: cpa };
    const nonTui = fakeContext({ modelRef: nonTuiSelection, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, nonTui.ctx);

    const fake = fakeContext({ model: cpa, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    holdDeepseek = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => heldStarted);

    // A switch advances the activation generation while the report is still
    // waiting for the non-active provider's credential.
    nonTuiSelection.current = other;
    await pi.emit("model_select", { type: "model_select", model: other, previousModel: cpa, source: "set" }, nonTui.ctx);
    release?.();
    await pending;
    // The report's own work may still finish, but the single stamp check discards
    // publishing it.
    assert.equal(fake.widgets.length, 0);
    assert.equal(fake.notifications.length, 0);
    host.shutdown(nonTui.ctx);
  });

  it("stops a report at shutdown instead of publishing a cancelled snapshot", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("api.deepseek.com")) {
        await gate;
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      return codexBody(10);
    }) as typeof fetch;
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const nonTui = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, nonTui.ctx);

    const fake = fakeContext({ model: cpa, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.some((url) => url.includes("api.deepseek.com")));

    // Shutdown aborts the pending GET; the cancelled snapshot must not be
    // published through a context Pi has already invalidated.
    host.shutdown(fake.ctx);
    release?.();
    await pending;
    assert.equal(fake.widgets.length, 0);
    assert.equal(fake.notifications.length, 0);
  });

  it("repaints stale footer qualifications from cache without another request", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(42)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry, advance } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry, mode: "print", hasUI: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    assert.equal(calls.length, 1);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /42%/);

    advance(900_000);
    await pi.emit("model_select", { type: "model_select", model, previousModel: model, source: "set" }, fake.ctx);
    assert.equal(calls.length, 1);
    const footer = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(footer, /reset elapsed/);
    assert.match(footer, /stale/);
    host.shutdown(fake.ctx);
  });

  it("appends a session entry instead of using the widget when no UI is available", async () => {
    const { fetchImpl } = sequenceFetch([codexBody(1)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry, hasUI: false, mode: "print" });
    const command = pi.commands.get(COMMAND_NAME);
    await command?.handler("", fake.ctx as unknown as ExtensionCommandContext);
    assert.equal(fake.widgets.length, 0);
    assert.equal(pi.entries[0]?.type, "universal-usage-report");
    host.shutdown(fake.ctx);
  });

  it("cleans up once and stops working after shutdown", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(1)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    host.shutdown(fake.ctx);
    const statusCount = fake.statuses.length;
    host.shutdown(fake.ctx);
    assert.equal(fake.statuses[statusCount - 1], undefined);
    const callsAfterShutdown = calls.length;
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls.length, callsAfterShutdown);
    const late = host as unknown as { timer?: unknown; timerContext?: unknown };
    assert.equal(late.timer, undefined, "the late startup did not rebuild the interval");
    assert.equal(late.timerContext, undefined, "the late startup did not retain its context");
  });

  it("ignores a held startup emission released after shutdown invalidated its context", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const { fetchImpl } = sequenceFetch([codexBody(1)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry });

    // An earlier extension holds a startup emission across a session shutdown and
    // the reload that invalidates the old runner's context, so this handler runs
    // after shutdown already cleared its scheduling state.
    const handlers = pi.handlers.get("session_start");
    assert.ok(handlers);
    handlers.unshift(async () => {
      held = true;
      await gate;
    });
    const pending = pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => held);
    host.shutdown(fake.ctx);
    const late = host as unknown as { timer?: unknown; timerContext?: unknown };
    assert.equal(late.timer, undefined);
    assert.equal(late.timerContext, undefined);

    let contextReads = 0;
    for (const field of ["mode", "model"] as const) {
      Object.defineProperty(fake.ctx, field, {
        get() {
          contextReads += 1;
          throw new Error(`STALE_CONTEXT_${field.toUpperCase()}`);
        },
        configurable: true,
      });
    }
    const statusesAfterShutdown = fake.statuses.length;

    release?.();
    await pending;

    assert.equal(contextReads, 0, "a disposed host never reads the invalidated context");
    assert.equal(fake.statuses.length, statusesAfterShutdown, "no footer is painted");
    assert.equal(late.timer, undefined, "the late startup did not rebuild the interval");
    assert.equal(late.timerContext, undefined, "the late startup did not retain its context");
  });

  it("ignores a held agent_end emission released after shutdown invalidated its context", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const { fetchImpl, calls } = sequenceFetch([codexBody(1)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);

    const handlers = pi.handlers.get("agent_end");
    assert.ok(handlers);
    handlers.unshift(async () => {
      held = true;
      await gate;
    });
    const pending = pi.emit("agent_end", { type: "agent_end" }, fake.ctx);
    await waitFor(() => held);
    host.shutdown(fake.ctx);
    let contextReads = 0;
    Object.defineProperty(fake.ctx, "mode", {
      get() {
        contextReads += 1;
        throw new Error("STALE_CONTEXT_MODE");
      },
      configurable: true,
    });
    const callsAfterShutdown = calls.length;

    release?.();
    await pending;

    assert.equal(contextReads, 0, "a disposed host reads no mode from the invalidated context");
    assert.equal(calls.length, callsAfterShutdown, "no after-turn work is started");
  });

  it("does not fetch or start a timer outside TUI mode", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(1)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    const timers = (host as unknown as { timer?: unknown }).timer;
    assert.equal(timers, undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);
    host.shutdown(fake.ctx);
  });

  it("does not fetch on startup or model selection when autoRefresh is disabled", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(1)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat-a", baseUrl: "http://localhost:8317/v1" });
    const modelB = fakeModel({ provider: "deepseek", id: "chat-b", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    selection.current = modelB;
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /automatic refresh is off/);
    host.shutdown(fake.ctx);
  });

  it("does not fetch on model selection outside TUI mode", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(1)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry, mode: "print" });
    await pi.emit("model_select", { type: "model_select", model, previousModel: undefined, source: "set" }, fake.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 0);
    host.shutdown(fake.ctx);
  });

  it("joins an in-flight startup refresh from /usage instead of cancelling it", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      await gate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4" }] });
    }) as typeof fetch;
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => fake.statuses.length > 0);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
    await pending;
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /state: ok/);
    assert.doesNotMatch(text, /cancelled/);
    assert.match(text, /balance \(USD\)/);
    host.shutdown(fake.ctx);
  });

  it("starts fresh work when switching models of the same provider during a pending refresh", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) await gate;
      return codexBody(33);
    }) as typeof fetch;
    const modelA = fakeModel({ provider: "cpa", id: "chat-a", baseUrl: "http://localhost:8317/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat-b", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB] });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => call === 1);
    selection.current = modelB;
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await waitFor(() => call === 2);
    release?.();
    await waitFor(() => String(fake.statuses[fake.statuses.length - 1]).includes("33%"));
    assert.doesNotMatch(String(fake.statuses[fake.statuses.length - 1]), /cancelled/);
    host.shutdown(fake.ctx);
  });

  it("re-resolves rotated credentials for the active provider before refreshing", async () => {
    let currentKey = "key-a";
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }] }),
    ]);
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      auth: () => ({ apiKey: currentKey, source: "stored" }),
    });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0]?.headers.authorization, "Bearer key-a");

    currentKey = "key-b";
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 2);
    assert.equal(calls[1]?.headers.authorization, "Bearer key-b");
    host.shutdown(fake.ctx);
  });

  it("re-resolves credentials when the same model is re-selected", async () => {
    let currentKey = "key-a";
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }] }),
    ]);
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], auth: () => ({ apiKey: currentKey, source: "stored" }) });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    currentKey = "key-b";
    await pi.emit("model_select", { type: "model_select", model, previousModel: model, source: "set" }, fake.ctx);
    await waitFor(() => calls.length === 2);
    assert.equal(calls[1]?.headers.authorization, "Bearer key-b");
    host.shutdown(fake.ctx);
  });

  it("uses the current same-ID model object for /usage routing", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:9999/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB] });
    const contextA = fakeContext({ model: modelA, registry });
    await pi.emit("session_start", { type: "session_start" }, contextA.ctx);
    await waitFor(() => calls.length === 1);
    assert.match(calls[0]?.url ?? "", /localhost:8317/);

    const contextB = fakeContext({ model: modelB, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", contextB.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 2);
    assert.match(calls[1]?.url ?? "", /localhost:9999/);
    host.shutdown(contextA.ctx);
  });

  it("adopts a same-ID model object from a model selection event", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:9999/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB] });
    // Pi installs the new model object before it emits model_select, so the
    // live selection already reads modelB when the handler runs.
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    selection.current = modelB;
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await waitFor(() => calls.length === 2);
    assert.match(calls[1]?.url ?? "", /localhost:9999/);
    host.shutdown(fake.ctx);
  });

  it("adopts same-ID routing with autoRefresh disabled and discards old work and attribution", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("a.example.com")) {
        await gate;
        return codexBody(11);
      }
      return codexBody(22);
    }) as typeof fetch;
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const fakeA = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fakeA.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fakeA.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fakeA.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 1);

    const fakeB = fakeContext({ model: modelB, registry, idle: false });
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fakeB.ctx);
    assert.match(String(fakeB.statuses[fakeB.statuses.length - 1]), /automatic refresh is off/);

    // Headers from the turn that began under A must not attach to B.
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90" } },
      fakeB.ctx,
    );
    assert.doesNotMatch(String(fakeB.statuses[fakeB.statuses.length - 1]), /90%/);

    release?.();
    await pending;
    assert.equal(calls.length, 1);
    assert.doesNotMatch(String(fakeA.statuses[fakeA.statuses.length - 1]), /11%/);
    assert.doesNotMatch(String(fakeB.statuses[fakeB.statuses.length - 1]), /11%|90%/);

    // A new turn under B is a sound attribution boundary.
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, fakeB.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      fakeB.ctx,
    );
    assert.match(String(fakeB.statuses[fakeB.statuses.length - 1]), /req 75%/);
    host.shutdown(fakeA.ctx);
  });

  it("adopts same-ID routing outside TUI without fetching and refuses old passive attribution", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(22)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB] });
    const fakeA = fakeContext({ model: modelA, registry, mode: "rpc", idle: false });
    await pi.emit("session_start", { type: "session_start" }, fakeA.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fakeA.ctx);

    const fakeB = fakeContext({ model: modelB, registry, mode: "rpc", idle: false });
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fakeB.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90" } },
      fakeB.ctx,
    );
    assert.doesNotMatch(String(fakeB.statuses[fakeB.statuses.length - 1]), /90%/);
    assert.equal(calls.length, 0);

    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, fakeB.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      fakeB.ctx,
    );
    assert.match(String(fakeB.statuses[fakeB.statuses.length - 1]), /req 75%/);

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fakeB.ctx as unknown as ExtensionCommandContext);
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /b\.example\.com/);
    host.shutdown(fakeA.ctx);
  });

  it("starts replacement work after an unchanged-identity reselection cancels a pending refresh", async () => {
    let calls = 0;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return codexBody(42);
    }) as typeof fetch;
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });

    // Establish the active target without an automatic fetch.
    const nonTui = fakeContext({ model, registry, mode: "rpc" });
    await pi.emit("session_start", { type: "session_start" }, nonTui.ctx);
    assert.equal(calls, 0);

    const tui = fakeContext({ model, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", tui.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls === 1);

    // Same model, same effective identity: the old monitor promise must be
    // detached so the replacement cannot join its cancelled sequence.
    await pi.emit("model_select", { type: "model_select", model, previousModel: model, source: "set" }, tui.ctx);
    await pending;
    await waitFor(() => calls === 2);
    const footer = String(tui.statuses[tui.statuses.length - 1]);
    assert.match(footer, /42%/);
    assert.doesNotMatch(footer, /cancelled|error/);
    host.shutdown(tui.ctx);
  });

  it("ignores an older same-ID routing resolution after a newer one", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:9999/v1" });
    let holdNext = false;
    let heldStarted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = (selected: { baseUrl: string }) => {
      if (holdNext) {
        heldStarted = true;
        holdNext = false;
        return { apiKey: "key-a", baseUrl: selected.baseUrl, wait: gate };
      }
      return { apiKey: "key-a", baseUrl: selected.baseUrl };
    };
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB], auth });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    assert.match(calls[0]?.url ?? "", /localhost:8317/);

    holdNext = true;
    const older = host.refreshActive(fake.ctx, { force: true, model: modelA });
    await waitFor(() => heldStarted);
    // The live selection moves to the newer same-ID route while the older
    // reconciliation is still pending.
    selection.current = modelB;
    const newer = host.refreshActive(fake.ctx, { force: true, model: modelB });
    await newer;
    await waitFor(() => calls.length === 2);
    assert.match(calls[1]?.url ?? "", /localhost:9999/);

    release?.();
    assert.equal(await older, undefined);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls.length, 2);
    assert.match(calls[1]?.url ?? "", /localhost:9999/);
    host.shutdown(fake.ctx);
  });

  it("discards passive headers from a request started before a model switch", async () => {
    const { fetchImpl } = sequenceFetch([codexBody(1)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat-a", baseUrl: "http://localhost:8317/v1" });
    // Same provider, origin, and credential: only the selected model changed.
    const modelB = fakeModel({ provider: "cpa", id: "chat-b", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry, advance } = buildHost({ fetchImpl, models: [modelA, modelB] });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => fake.statuses.length > 0);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);

    selection.current = modelB;
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterSwitch = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(afterSwitch, /cpa/);

    // A's delayed response headers arrive while B is active: attribution is not sound.
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90", "x-codex-secondary-window-minutes": "10080" } },
      fake.ctx,
    );
    assert.doesNotMatch(String(fake.statuses[fake.statuses.length - 1]), /90%/);

    // A new turn under B is a sound boundary. Once the endpoint snapshot is
    // stale, B's own headers apply again.
    advance(400_000);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, fake.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      fake.ctx,
    );
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /req 75%/);
    host.shutdown(fake.ctx);
  });

  it("refuses passive attribution for a same-ID routing change Pi did not report", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const fake = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    assert.equal(calls.length, 0);

    // Pi's setModel() updates the selection but suppresses model_select for a
    // same provider/id/type model, even when its base URL changed. Only ctx.model
    // reveals routing B, so its headers must not land on A's identity.
    const selected = fakeContext({ model: modelB, registry, idle: false });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, selected.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90" } },
      selected.ctx,
    );
    assert.equal(selected.statuses.length, 0);
    assert.equal(calls.length, 0);

    // An unreported selection of the same routing keeps attribution sound.
    const sameRoute = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const unchanged = fakeContext({ model: sameRoute, registry, idle: false });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, unchanged.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      unchanged.ctx,
    );
    assert.match(String(unchanged.statuses[unchanged.statuses.length - 1]), /req 75%/);
    host.shutdown(fake.ctx);
  });

  it("keeps passive attribution for reordered, recased copies of the same routing headers", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { "X-Routing": "blue", "ChatGPT-Account-Id": "acct-a" },
    });
    const equivalent = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { "chatgpt-account-id": "acct-a", "x-routing": "blue" },
    });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const bound = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, bound.ctx);

    const equivalentContext = fakeContext({ model: equivalent, registry, idle: false });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, equivalentContext.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      equivalentContext.ctx,
    );
    assert.match(String(equivalentContext.statuses[equivalentContext.statuses.length - 1]), /req 75%/);
    assert.equal(calls.length, 0);
    host.shutdown(bound.ctx);
  });

  it("keeps turn attribution when a refresh meets an equivalent model replacement", async () => {
    const { fetchImpl, calls } = sequenceFetch([textResponse("unexpected request")]);
    const model = fakeModel({ provider: "openai", id: "chat", baseUrl: "https://api.openai.com/v1" });
    // Pi substitutes an equivalent object for the same logical model: same URL,
    // API, and equivalent header map, so it emits no `model_select`.
    const equivalent = fakeModel({ provider: "openai", id: "chat", baseUrl: "https://api.openai.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: model };
    const fake = fakeContext({ modelRef: selection, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);

    selection.current = equivalent;
    // An intervening refresh resolves the equivalent object back to the same
    // effective identity, so the turn's attribution stays sound.
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "500" } },
      fake.ctx,
    );

    assert.match(String(fake.statuses[fake.statuses.length - 1]), /req 50%/);
    assert.equal(calls.length, 0, "the passive-only target still needs no request");
    host.shutdown(fake.ctx);
  });

  it("discards passive headers when the selection moves before the response", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const fake = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    // The turn begins on A's routing, so the boundary itself is sound.
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);

    // The selection moves to the unreported same-ID routing before the answer.
    const moved = fakeContext({ model: modelB, registry, idle: false });
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      moved.ctx,
    );
    assert.equal(moved.statuses.length, 0);
    assert.equal(calls.length, 0);
    host.shutdown(fake.ctx);
  });

  it("keeps a pending-activation report after activation adopts the same route's failure", async () => {
    let holdActivationAuth = true;
    let activationAuthReached = false;
    let releaseActivationAuth: (() => void) | undefined;
    const activationAuthGate = new Promise<void>((resolve) => {
      releaseActivationAuth = resolve;
    });
    let holdPeerAuth = false;
    let peerAuthReached = false;
    let releasePeerAuth: (() => void) | undefined;
    const peerAuthGate = new Promise<void>((resolve) => {
      releasePeerAuth = resolve;
    });
    const activeCalls: string[] = [];
    const peerCalls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.deepseek.com")) {
        peerCalls.push(url);
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      activeCalls.push(url);
      return codexBody(11);
    }) as typeof fetch;
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.provider === "deepseek") {
        if (holdPeerAuth) {
          peerAuthReached = true;
          return { apiKey: "key-a", source: "stored", wait: peerAuthGate };
        }
        return { apiKey: "key-a", source: "stored" };
      }
      if (holdActivationAuth) {
        holdActivationAuth = false;
        activationAuthReached = true;
        return { ok: false, error: "removed credential", wait: activationAuthGate };
      }
      return { apiKey: "key-a", source: "stored" };
    };
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://a.example/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false, providers: { deepseek: { enabled: true } } }),
    });
    const fake = fakeContext({ model: cpa, registry });
    const activation = host.activate(fake.ctx, cpa, { refresh: false });
    await waitFor(() => activationAuthReached);

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    holdPeerAuth = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => peerAuthReached);
    assert.equal(activeCalls.length, 1);

    // Activation adopts a sanitized failure for the same route the report
    // captured, so the pending report still owns its authority.
    releaseActivationAuth?.();
    await activation;
    releasePeerAuth?.();
    await pending;

    assert.equal(peerCalls.length, 1, "the captured route still authorizes the peer");
    assert.equal(fake.widgets.length, 1, "the report is published");
    const text = (fake.widgets[0]?.lines ?? []).join("\n");
    assert.match(text, /11%/);
    assert.match(text, /balance \(USD\)/);
    assert.equal(activeCalls.length, 1);
    host.shutdown(fake.ctx);
  });

  it("keeps a pre-activation report through a same-route failure re-adoption", async () => {
    let holdActivationAuth = true;
    let activationAuthReached = false;
    let releaseActivationAuth: (() => void) | undefined;
    const activationAuthGate = new Promise<void>((resolve) => {
      releaseActivationAuth = resolve;
    });
    let holdPeerAuth = false;
    let peerAuthReached = false;
    let releasePeerAuth: (() => void) | undefined;
    const peerAuthGate = new Promise<void>((resolve) => {
      releasePeerAuth = resolve;
    });
    const peerCalls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.deepseek.com")) {
        peerCalls.push(url);
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      return codexBody(11);
    }) as typeof fetch;
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.provider === "deepseek") {
        if (holdPeerAuth) {
          peerAuthReached = true;
          return { apiKey: "key-a", source: "stored", wait: peerAuthGate };
        }
        return { apiKey: "key-a", source: "stored" };
      }
      const held = holdActivationAuth;
      holdActivationAuth = false;
      if (held) activationAuthReached = true;
      return { ok: false, error: "removed credential", ...(held ? { wait: activationAuthGate } : {}) };
    };
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://a.example/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false, providers: { deepseek: { enabled: true } } }),
    });
    const fake = fakeContext({ model: cpa, registry });
    const activation = host.activate(fake.ctx, cpa, { refresh: false });
    await waitFor(() => activationAuthReached);

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    holdPeerAuth = true;
    const pending = command.handler("deepseek", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => peerAuthReached);

    // The same route adopts its failure again while the report waits: that is
    // not a new accepted binding, so the report keeps its authority.
    releaseActivationAuth?.();
    await activation;
    await host.refreshActive(fake.ctx, {} );
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /no-credential/);

    releasePeerAuth?.();
    await pending;

    assert.equal(peerCalls.length, 1, "the unchanged accepted route keeps the report's authority");
    assert.equal(fake.widgets.length, 1, "the report is published");
    const text = (fake.widgets[0]?.lines ?? []).join("\n");
    assert.match(text, /deepseek\/chat/);
    assert.match(text, /balance \(USD\)/);
    assert.match(text, /cpa\/chat/);
    assert.match(text, /state: no-credential/);
    host.shutdown(fake.ctx);
  });

  it("keeps a report waiting on a peer through an unchanged-source refresh", async () => {
    let currentKey = "key-a";
    let holdPeerAuth = false;
    let peerAuthReached = false;
    let releasePeerAuth: (() => void) | undefined;
    const peerAuthGate = new Promise<void>((resolve) => {
      releasePeerAuth = resolve;
    });
    const activeCalls: string[] = [];
    const peerCalls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.deepseek.com")) {
        peerCalls.push(url);
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      activeCalls.push(url);
      return codexBody(activeCalls.length * 11);
    }) as typeof fetch;
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.provider === "deepseek") {
        if (holdPeerAuth) {
          peerAuthReached = true;
          return { apiKey: "key-a", source: "stored", wait: peerAuthGate };
        }
        return { apiKey: "key-a", source: "stored" };
      }
      return { apiKey: currentKey, source: "stored" };
    };
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://a.example/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false, providers: { deepseek: { enabled: true } } }),
    });
    const fake = fakeContext({ model: cpa, registry });
    await host.activate(fake.ctx, cpa, { refresh: false });

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    holdPeerAuth = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => peerAuthReached);

    // An ordinary refresh of the same credential is not a source change.
    await host.refreshActive(fake.ctx, { force: true });
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /22%/);

    releasePeerAuth?.();
    await pending;

    assert.equal(peerCalls.length, 1, "an unchanged source keeps the report's authority");
    assert.equal(fake.widgets.length, 1, "the report is published");
    const text = (fake.widgets[0]?.lines ?? []).join("\n");
    // The report keeps its own collected snapshot, not the ordinary refresh's.
    assert.match(text, /11%/);
    assert.doesNotMatch(text, /22%/);
    assert.match(text, /balance \(USD\)/);
    assert.equal(activeCalls.length, 2);
    host.shutdown(fake.ctx);
  });

  it("discards a pending active refresh when the live selection changes route without an event", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      await gate;
      return codexBody(88);
    }) as typeof fetch;
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const activation = fakeContext({ model: modelA, registry, mode: "rpc" });
    await pi.emit("session_start", { type: "session_start" }, activation.ctx);
    assert.equal(calls.length, 0);

    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 1);

    // Pi replaces the selected model object without model_select because
    // provider, id, and type still match. The request in flight belongs to A.
    selection.current = modelB;
    release?.();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    assert.equal(fake.statuses.length, 0);
    assert.equal(fake.widgets.length, 0);
    assert.equal(fake.notifications.length, 0);
    host.shutdown(activation.ctx);
  });

  it("discards a report waiting on another provider after an unreported route change", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("api.deepseek.com")) {
        await gate;
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      return codexBody(15);
    }) as typeof fetch;
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const cpaMoved = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const activation = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, activation.ctx);

    const selection = { current: cpa };
    const fake = fakeContext({ modelRef: selection, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.some((url) => url.includes("api.deepseek.com")));

    selection.current = cpaMoved;
    release?.();
    await pending;
    assert.equal(fake.widgets.length, 0);
    assert.equal(fake.notifications.length, 0);
    host.shutdown(activation.ctx);
  });

  it("reports a configured provider with no registered model instead of omitting it", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(15)]);
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const config = normalizeConfig({
      providers: { cpa: { enabled: true }, "missing-provider": { enabled: true } },
    });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [cpa], config });
    const fake = fakeContext({ model: cpa, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /cpa\/chat/);
    assert.match(text, /missing-provider\/no model/);
    assert.match(text, /state: unknown/);
    assert.match(text, /notice: no registered model could be resolved for this provider/);
    assert.equal(calls.length, 1);
    host.shutdown(fake.ctx);
  });

  it("explains a requested provider with no registered model alongside the active snapshot", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [cpa] });
    const fake = fakeContext({ model: cpa, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => String(fake.statuses[fake.statuses.length - 1] ?? "").includes("12%"));

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("missing-provider", fake.ctx as unknown as ExtensionCommandContext);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /missing-provider\/no model/);
    assert.match(text, /notice: no registered model could be resolved for this provider/);
    assert.match(text, /cpa\/chat/);
    assert.equal(calls.length, 1);
    host.shutdown(fake.ctx);
  });
});

/** A model-routing header map that can carry an explicit `null` suppression. */
function modelWithHeaders(
  model: ReturnType<typeof fakeModel>,
  headers: Record<string, string | null>,
): ReturnType<typeof fakeModel> {
  return { ...model, headers } as unknown as ReturnType<typeof fakeModel>;
}

describe("host routing binding", () => {
  it("drops a held activation success after a silent same-ID route replacement", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const auth = (): FakeAuth => {
      reached = true;
      return { apiKey: "key-a", source: "stored", wait: gate };
    };
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const { host, registry } = buildHost({ fetchImpl, models: [model], auth, timers: false });
    const selection = { current: model };
    const fake = fakeContext({ modelRef: selection, registry });

    const pending = host.activate(fake.ctx, model);
    await waitFor(() => reached);
    selection.current = { ...model, baseUrl: "http://b.example.com/v1" };
    release?.();
    await pending;

    assert.equal(calls.length, 0);
    assert.deepEqual(fake.statuses, ["cpa: checking usage..."]);
    host.shutdown(fake.ctx);
  });

  it("drops a held activation failure after a silent same-ID route replacement", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    const auth = (): FakeAuth => {
      reached = true;
      return { ok: false, error: "removed credential", wait: gate };
    };
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const { host, registry } = buildHost({ fetchImpl, models: [model], auth, timers: false });
    const selection = { current: model };
    const fake = fakeContext({ modelRef: selection, registry });

    const pending = host.activate(fake.ctx, model);
    await waitFor(() => reached);
    selection.current = { ...model, baseUrl: "http://b.example.com/v1" };
    release?.();
    await pending;

    assert.equal(calls.length, 0);
    // Neither the failure nor a follow-on request may describe the old route.
    assert.deepEqual(fake.statuses, ["cpa: checking usage..."]);
    host.shutdown(fake.ctx);
  });

  it("stops a held request when another model is installed before its selection event", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      await gate;
      return codexBody(77);
    }) as typeof fetch;
    const modelA = fakeModel({ provider: "cpa", id: "chat-a", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat-b", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry, idle: false });
    await host.activate(fake.ctx, modelA, { refresh: false });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);
    const pending = host.report(fake.ctx as unknown as ExtensionCommandContext, "");
    await waitFor(() => calls.length === 1);
    const statusesBefore = fake.statuses.length;

    // Pi installs the new selection before it emits model_select and awaits an
    // earlier extension handler first, so this host has not seen the event yet.
    selection.current = modelB;
    release?.();
    await pending;

    assert.equal(calls.length, 1, "the replaced selection issues no follow-on request");
    assert.equal(fake.statuses.length, statusesBefore, "the replaced selection paints no footer");
    assert.equal(pi.entries.length + fake.widgets.length + fake.notifications.length, 0, "it publishes no report");

    // The turn that began under A cannot lend its headers to the installed B.
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90", "x-codex-secondary-window-minutes": "10080" } },
      fake.ctx,
    );
    assert.equal(fake.statuses.length, statusesBefore, "no passive measurement is attributed");

    // The event that follows still adopts the installed selection and its work.
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /automatic refresh is off/);
    await host.refreshActive(fake.ctx, {} );
    assert.equal(calls.length, 2);
    assert.match(calls[1] ?? "", /b\.example\.com/);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /77%/);
    host.shutdown(fake.ctx);
  });

  it("does not adopt a held credential resolution for a model that is no longer selected", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.id === "chat-a" && !held) {
        held = true;
        return { apiKey: "key-a", source: "stored", wait: gate };
      }
      return { apiKey: "key-b", source: "stored" };
    };
    const { fetchImpl, calls } = sequenceFetch([codexBody(33)]);
    const modelA = fakeModel({ provider: "cpa", id: "chat-a", baseUrl: "http://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat-b", baseUrl: "http://b.example.com/v1" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [modelA, modelB], auth, timers: false });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });

    const activation = host.activate(fake.ctx, modelA);
    await waitFor(() => held);
    selection.current = modelB;
    release?.();
    await activation;

    assert.equal(calls.length, 0, "the replaced selection starts no request");
    assert.deepEqual(fake.statuses, ["cpa: checking usage..."]);

    // The pending event still activates the model Pi already installed.
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await host.refreshActive(fake.ctx, {} );
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /b\.example\.com/);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /33%/);
    host.shutdown(fake.ctx);
  });

  it("keeps the newer selection when an older selection event arrives late", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const modelX = fakeModel({ provider: "provider-x", id: "chat-x", baseUrl: "https://x.example.com/v1" });
    const modelA = fakeModel({ provider: "provider-a", id: "chat-a", baseUrl: "https://a.example.com/v1" });
    const modelB = fakeModel({ provider: "provider-b", id: "chat-b", baseUrl: "https://b.example.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([codexBody(33)]);
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelX, modelA, modelB],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: modelX };
    const fake = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);

    // An earlier extension holds A's selection event, so Pi installs B and lets
    // B's event reach this host first.
    const handlers = pi.handlers.get("model_select");
    assert.ok(handlers);
    handlers.unshift(async (event: { model: ReturnType<typeof fakeModel> }) => {
      if (event.model !== modelA) return;
      held = true;
      await gate;
    });
    selection.current = modelA;
    const pendingA = pi.emit("model_select", { type: "model_select", model: modelA, previousModel: modelX, source: "set" }, fake.ctx);
    await waitFor(() => held);
    selection.current = modelB;
    await pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    const adopted = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(adopted, /provider-b/);

    release?.();
    await pendingA;

    assert.equal(
      String(fake.statuses[fake.statuses.length - 1]),
      adopted,
      "the obsolete event keeps the accepted view of the live selection",
    );
    assert.equal(calls.length, 0);
    const snapshot = await host.refreshActive(fake.ctx, {} );
    assert.ok(snapshot, "the live selection is still refreshable");
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /b\.example\.com/);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /33%/);
    host.shutdown(fake.ctx);
  });

  it("keeps a newer same-ID reselection when an older event arrives late", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const modelA = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://a.example.com/v1" });
    const modelB = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://b.example.com/v1" });
    const modelC = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://c.example.com/v1" });
    const { fetchImpl } = sequenceFetch([codexBody(44)]);
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB, modelC],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);

    // The older same-ID routing (B) is held while the newer one (C) is adopted.
    const handlers = pi.handlers.get("model_select");
    assert.ok(handlers);
    handlers.unshift(async (event: { model: ReturnType<typeof fakeModel> }) => {
      if (event.model !== modelB) return;
      held = true;
      await gate;
    });
    selection.current = modelB;
    const pendingB = pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await waitFor(() => held);
    selection.current = modelC;
    await pi.emit("model_select", { type: "model_select", model: modelC, previousModel: modelB, source: "set" }, fake.ctx);
    // A new turn under the adopted C is a sound attribution boundary.
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, fake.ctx);

    release?.();
    await pendingB;

    // The obsolete event may not cancel work or drop the attribution of the
    // reselection that is actually live.
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90", "x-codex-secondary-window-minutes": "10080" } },
      fake.ctx,
    );
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /90%/);
    host.shutdown(fake.ctx);
  });

  it("still adopts an equivalent selection event object", async () => {
    const active = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "https://a.example/v1",
      headers: { Authorization: "Bearer synthetic-a", "ChatGPT-Account-Id": "a" },
    });
    // The live selection and the event describe the same route with recased,
    // reordered headers, so the event is current although it is another object.
    const live = modelWithHeaders(active, { "chatgpt-account-id": "a", authorization: "Bearer synthetic-a" });
    const { fetchImpl, calls } = sequenceFetch([codexBody(21)]);
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [active, live],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const fake = fakeContext({ modelRef: { current: live }, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);

    await pi.emit("model_select", { type: "model_select", model: active, previousModel: live, source: "set" }, fake.ctx);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /automatic refresh is off/);

    await host.refreshActive(fake.ctx, {} );
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /a\.example/);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /21%/);
    host.shutdown(fake.ctx);
  });

  it("ignores a held selection event after shutdown invalidated its context", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const modelA = fakeModel({ provider: "provider-a", id: "chat-a", baseUrl: "https://a.example.com/v1" });
    const modelB = fakeModel({ provider: "provider-b", id: "chat-b", baseUrl: "https://b.example.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const { pi, registry } = buildHost({
      fetchImpl,
      models: [modelA, modelB],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);

    // An earlier extension holds B's selection event across a shutdown.
    const handlers = pi.handlers.get("model_select");
    assert.ok(handlers);
    handlers.unshift(async (event: { model: ReturnType<typeof fakeModel> }) => {
      if (event.model !== modelB) return;
      held = true;
      await gate;
    });
    selection.current = modelB;
    const pending = pi.emit("model_select", { type: "model_select", model: modelB, previousModel: modelA, source: "set" }, fake.ctx);
    await waitFor(() => held);

    await pi.emit("session_shutdown", { type: "session_shutdown" }, fake.ctx);
    // Pi invalidates the old runner's context after shutdown: its guarded getters
    // now throw, and the emission that already started still resumes.
    let modelReads = 0;
    Object.defineProperty(fake.ctx, "model", {
      get() {
        modelReads += 1;
        throw new Error("STALE_CONTEXT_MODEL");
      },
      configurable: true,
    });
    const statusesAfterShutdown = fake.statuses.length;

    release?.();
    await pending;

    assert.equal(modelReads, 0, "a disposed host never reads the invalidated context");
    assert.equal(fake.statuses.length, statusesAfterShutdown, "no footer is painted");
    assert.equal(pi.entries.length + fake.widgets.length + fake.notifications.length, 0, "nothing is published");
    assert.equal(calls.length, 0, "no work is started");
  });

  it("continues same-origin discovery for a reported provider", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return calls.length === 1 ? textResponse("not found", { status: 404 }) : codexBody(42);
    }) as typeof fetch;
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://a.example/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const fake = fakeContext({ modelRef: { current: model }, registry });
    await host.activate(fake.ctx, model, { refresh: false });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);

    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);

    assert.equal(calls.length, 2, "discovery continues past the first candidate");
    assert.match(calls[1] ?? "", /backend-api\/wham\/usage/);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /42%/);
    assert.equal(fake.widgets.length, 1);
    host.shutdown(fake.ctx);
  });

  it("requests the optional sibling endpoint of a reported provider", async () => {
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse({ data: { limit: 20, limit_remaining: 15, limit_reset: "monthly" } }),
      jsonResponse({ data: { total_credits: 100, total_usage: 20 } }),
    ]);
    const model = fakeModel({ provider: "openrouter", id: "chat", baseUrl: "https://openrouter.ai/api/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const fake = fakeContext({ modelRef: { current: model }, registry });
    await host.activate(fake.ctx, model, { refresh: false });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);

    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);

    assert.equal(calls.length, 2, "the optional sibling is still requested");
    assert.match(calls[1]?.url ?? "", /\/api\/v1\/credits$/);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /state: ok/);
    host.shutdown(fake.ctx);
  });

  it("shares one peer request between two concurrent reports", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let peerCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("peer.example.com")) return codexBody(12);
      peerCalls += 1;
      await gate;
      return codexBody(25);
    }) as typeof fetch;
    const active = fakeModel({ provider: "cpa", id: "chat", baseUrl: "https://a.example/v1" });
    const peer = fakeModel({ provider: "peer", id: "chat", baseUrl: "https://peer.example.com/v1" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [active, peer],
      timers: false,
      config: normalizeConfig({ autoRefresh: false, providers: { peer: { enabled: true } } }),
    });
    const selection = { current: active };
    const first = fakeContext({ modelRef: selection, registry });
    const second = fakeContext({ modelRef: selection, registry });
    await host.activate(first.ctx, active, { refresh: false });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);

    const firstReport = command.handler("", first.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => peerCalls === 1);
    const secondReport = command.handler("", second.ctx as unknown as ExtensionCommandContext);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
    await Promise.all([firstReport, secondReport]);

    assert.equal(peerCalls, 1, "the monitor serves both reports from one request");
    for (const fake of [first, second]) {
      assert.equal(fake.widgets.length, 1);
      const text = (fake.widgets[0]?.lines ?? []).join("\n");
      assert.match(text, /peer\/chat/);
      assert.match(text, /25%/);
      assert.doesNotMatch(text, /refresh cancelled/);
    }
    host.shutdown(first.ctx);
  });

  it("re-resolves the live route after the selected model object was mutated in place", async () => {
    const model = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { Authorization: "Bearer synthetic-a" },
    });
    const resolved: string[] = [];
    const auth = (input: ReturnType<typeof fakeModel>): FakeAuth => {
      // getProviderAuthStatus receives a provider id, not a model.
      if (typeof input === "object") resolved.push(`${input.baseUrl} ${input.headers?.Authorization ?? "-"}`);
      return { apiKey: "synthetic", headers: input.headers, baseUrl: input.baseUrl };
    };
    const { fetchImpl, calls } = sequenceFetch([codexBody(42)]);
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    assert.equal(calls.length, 0);

    // Pi can reconfigure the adopted object instead of replacing it.
    model.baseUrl = "http://b.example.com/v1";
    model.headers = { Authorization: "Bearer synthetic-b" };

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 1);

    // The new reconciliation describes the route the user is on now, so the
    // command re-anchors instead of rejecting the mutated selection forever.
    assert.match(calls[0]?.url ?? "", /b\.example\.com/);
    assert.equal(calls[0]?.headers.authorization, "Bearer synthetic-b");
    assert.equal(resolved[resolved.length - 1], "http://b.example.com/v1 Bearer synthetic-b");
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /42%/);

    // A later command keeps working against the same mutated object.
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 2);
    assert.match(calls[1]?.url ?? "", /b\.example\.com/);
    assert.equal(fake.widgets.length, 2, "each command published its own report");
    host.shutdown(fake.ctx);
  });

  it("rejects work whose route changed while pending and re-anchors on the next command", async () => {
    const model = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { Authorization: "Bearer synthetic-a" },
    });
    let held = false;
    let reached = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = (input: ReturnType<typeof fakeModel>): FakeAuth => {
      const base: FakeAuth = { apiKey: "synthetic", headers: input.headers, baseUrl: input.baseUrl };
      if (!held) return base;
      held = false;
      reached = true;
      return { ...base, wait: gate };
    };
    const { fetchImpl, calls } = sequenceFetch([codexBody(42)]);
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);

    held = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => reached);
    // The route moves while the resolver for the captured route is still pending.
    model.baseUrl = "http://b.example.com/v1";
    release?.();
    await pending;

    assert.equal(calls.length, 0, "no request for the route the selection left");
    assert.equal(fake.widgets.length, 0, "no report from the stale route");

    // The next command starts from the live route and recovers.
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 1);
    assert.match(calls[0]?.url ?? "", /b\.example\.com/);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /42%/);
    host.shutdown(fake.ctx);
  });

  it("joins startup, interval, and /usage refreshes of one target into a single HTTP sequence", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      await gate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4" }] });
    }) as typeof fetch;
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model] });
    const fake = fakeContext({ model, registry });

    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    // A periodic tick is the call the interval timer makes; the reconciliation
    // it starts must not revoke the refresh it is about to join.
    const interval = host.refreshActive(fake.ctx, {} );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const usage = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
    await Promise.all([interval, usage]);

    assert.equal(calls.length, 1, "one HTTP sequence for one target");
    assert.equal(fake.widgets.length, 1, "one report publication");
    const footer = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(footer, /USD \$4/);
    assert.doesNotMatch(footer, /cancelled|error/);
    host.shutdown(fake.ctx);
  });

  it("joins an equivalent-header command to the same HTTP sequence", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      await gate;
      return codexBody(12);
    }) as typeof fetch;
    const declared = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "https://a.example/v1",
      headers: { Authorization: "Bearer synthetic-a", "ChatGPT-Account-Id": "a" },
    });
    const equivalent = modelWithHeaders(declared, { "chatgpt-account-id": "a", authorization: "Bearer synthetic-a" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [declared, equivalent],
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: declared };
    const fake = fakeContext({ modelRef: selection, registry });
    await host.activate(fake.ctx, declared, { refresh: false });

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const first = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 1);

    // A recased, reordered copy of the same routing is the same route.
    selection.current = equivalent;
    const second = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release?.();
    await Promise.all([first, second]);

    assert.equal(calls.length, 1, "an equivalent route joins the same HTTP sequence");
    assert.equal(fake.widgets.length, 2, "each command publishes its own report");
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /12%/);
    host.shutdown(fake.ctx);
  });

  it("does not paint or fetch a credential that resolves after shutdown", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = (): FakeAuth => ({ apiKey: "key-a", source: "stored", wait: gate });
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const { host, registry } = buildHost({ fetchImpl, models: [model], auth, timers: false });
    const fake = fakeContext({ model, registry });

    const pending = host.activate(fake.ctx, model);
    await waitFor(() => fake.statuses.length > 0);
    host.shutdown(fake.ctx);
    const statusesAfterShutdown = fake.statuses.length;
    release?.();
    await pending;

    assert.equal(fake.statuses.length, statusesAfterShutdown);
    assert.equal(calls.length, 0);
  });

  it("does not publish a report for a route the selection left while activation is pending", async () => {
    const modelA = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "https://a.example/v1",
      headers: { Authorization: "Bearer synthetic-a" },
    });
    let activationHeld = false;
    let activationReached = false;
    let releaseActivation: (() => void) | undefined;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let commandHeld = false;
    let commandReached = false;
    let releaseCommand: (() => void) | undefined;
    const commandGate = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const auth = (): FakeAuth => {
      if (activationHeld) {
        activationHeld = false;
        activationReached = true;
        return { apiKey: "synthetic", wait: activationGate };
      }
      if (commandHeld) {
        commandHeld = false;
        commandReached = true;
        return { apiKey: "synthetic", wait: commandGate };
      }
      return { apiKey: "synthetic" };
    };
    const { fetchImpl } = sequenceFetch([codexBody(42)]);
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });

    // Startup holds its initial credential resolution, so no binding is adopted.
    activationHeld = true;
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => activationReached);

    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    commandHeld = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => commandReached);

    // Pi replaces the selected object for an equal logical model without
    // emitting model_select, so only the live getter reveals the new route.
    selection.current = { ...modelA, baseUrl: "https://b.example/v1" };
    releaseCommand?.();
    await pending;

    // The request itself belongs to the route the report started under; only
    // publication is decided by the stamp check, which has moved.
    assert.equal(fake.widgets.length, 0, "no report from the abandoned route");
    assert.equal(pi.entries.length, 0);

    releaseActivation?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.shutdown(fake.ctx);
  });

  it("does not publish a request whose route moved while activation is still pending", async () => {
    const modelA = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "https://a.example/v1",
      headers: { Authorization: "Bearer synthetic-a" },
    });
    let activationHeld = false;
    let releaseActivation: (() => void) | undefined;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let releaseGet: (() => void) | undefined;
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let getReached = false;
    const fetchImpl = (async () => {
      getReached = true;
      await getGate;
      return codexBody(42);
    }) as typeof fetch;
    const auth = (): FakeAuth => {
      if (!activationHeld) return { apiKey: "synthetic" };
      activationHeld = false;
      return { apiKey: "synthetic", wait: activationGate };
    };
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA],
      auth,
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const selection = { current: modelA };
    const fake = fakeContext({ modelRef: selection, registry });

    activationHeld = true;
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => getReached);

    // The command's request is in flight for the captured route while the
    // selection silently moves to another one.
    selection.current = { ...modelA, baseUrl: "https://b.example/v1" };
    releaseGet?.();
    await pending;

    assert.equal(fake.widgets.length, 0, "no report from the abandoned route");
    assert.equal(pi.entries.length, 0);

    releaseActivation?.();
    host.shutdown(fake.ctx);
  });
});
