import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
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
    const fakeA = fakeContext({ model: modelA, registry });
    await pi.emit("session_start", { type: "session_start" }, fakeA.ctx);
    await waitFor(() => fakeA.statuses.length > 0);

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

  it("keeps a passive-only measurement when /usage has no endpoint to request", async () => {
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

    const footer = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(footer, /req 75%/);
    assert.doesNotMatch(footer, /no quota interface/);
    const text = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(text, /openai\/chat/);
    assert.match(text, /state: ok \[rate-limit-headers\] \(source: headers\)/);
    assert.match(text, /requests 75%/);
    // The original measurement timestamp is preserved, not reset by the command.
    assert.match(text, /age: 2m/);
    assert.match(text, /notice: .*no subscription quota endpoint is requested/);
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
    const { fetchImpl, calls } = sequenceFetch([codexBody(10)]);
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
    const nonTui = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, nonTui.ctx);

    const fake = fakeContext({ model: cpa, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    holdDeepseek = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => heldStarted);
    const callsBeforeSwitch = calls.length;

    // A switch advances the activation generation and cancels older work while
    // the report is still waiting for the non-active provider's credential.
    await pi.emit("model_select", { type: "model_select", model: other, previousModel: cpa, source: "set" }, nonTui.ctx);
    release?.();
    await pending;
    assert.equal(calls.length, callsBeforeSwitch);
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
    const fake = fakeContext({ model: modelA, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
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
    const fake = fakeContext({ model: modelA, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => call === 1);
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

  it("invalidates a pending refresh when credential reconciliation fails", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = false;
    const fetchImpl = (async () => {
      await gate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "7.5" }] });
    }) as typeof fetch;
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      auth: () => (fail ? { ok: false, error: "removed credential" } : { apiKey: "key-a", source: "stored" }),
    });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));

    fail = true;
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    await command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    const failureWidget = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(failureWidget, /state: no-credential/);
    assert.match(failureWidget, /no usable credential/);

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const finalWidget = (fake.widgets[fake.widgets.length - 1]?.lines ?? []).join("\n");
    assert.match(finalWidget, /state: no-credential/);
    assert.doesNotMatch(finalWidget, /7\.5/);
    assert.doesNotMatch(String(fake.statuses[fake.statuses.length - 1]), /7\.5/);
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

  it("ignores an older pending auth success after a newer reconciliation failure", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    let phase: "ok" | "hold" | "fail" = "ok";
    let heldStarted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = () => {
      if (phase === "hold") {
        heldStarted = true;
        phase = "ok";
        return { apiKey: "key-a", wait: gate };
      }
      if (phase === "fail") return { ok: false, error: "removed credential" };
      return { apiKey: "key-a", source: "stored" as const };
    };
    const { pi, host, registry } = buildHost({ fetchImpl, models: [model], auth });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);

    phase = "hold";
    const older = host.refreshActive(fake.ctx, { reason: "older", force: true });
    await waitFor(() => heldStarted);
    phase = "fail";
    const newer = host.refreshActive(fake.ctx, { reason: "newer", force: true });
    await newer;
    assert.equal(String(fake.statuses[fake.statuses.length - 1]).includes("no-credential"), true);

    const callsBeforeRelease = calls.length;
    release?.();
    assert.equal(await older, undefined);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls.length, callsBeforeRelease);
    assert.equal(String(fake.statuses[fake.statuses.length - 1]).includes("no-credential"), true);
    host.shutdown(fake.ctx);
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
    const older = host.refreshActive(fake.ctx, { reason: "older", force: true, model: modelA });
    await waitFor(() => heldStarted);
    // The live selection moves to the newer same-ID route while the older
    // reconciliation is still pending.
    selection.current = modelB;
    const newer = host.refreshActive(fake.ctx, { reason: "newer", force: true, model: modelB });
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
    const fake = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => fake.statuses.length > 0);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);

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

  it("refuses passive attribution for a header-only same-ID routing change Pi did not report", async () => {
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const modelA = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { "ChatGPT-Account-Id": "acct-a" },
    });
    const modelB = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { "ChatGPT-Account-Id": "acct-b" },
    });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [modelA],
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
    });
    const bound = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("session_start", { type: "session_start" }, bound.ctx);
    assert.equal(calls.length, 0);

    // Pi replaces the selection without model_select because provider, id, and
    // type match; only the account-routing header changed. A turn that starts
    // after that change cannot inherit A's identity.
    const moved = fakeContext({ model: modelB, registry, idle: false });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, moved.ctx);
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "25" } },
      moved.ctx,
    );
    assert.equal(moved.statuses.length, 0);

    // A turn that began on A is sound; the same header change before the
    // response makes the result ambiguous, so it is dropped too.
    const sound = fakeContext({ model: modelA, registry, idle: false });
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() }, sound.ctx);
    const shifted = fakeContext({ model: modelB, registry, idle: false });
    await pi.emit(
      "after_provider_response",
      { status: 200, headers: { "x-codex-secondary-used-percent": "90" } },
      shifted.ctx,
    );
    assert.equal(shifted.statuses.length, 0);
    assert.equal(sound.statuses.length, 0);
    assert.equal(calls.length, 0);
    host.shutdown(bound.ctx);
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

  it("stops a report when the active credential rotates while another provider's credential is pending", async () => {
    let currentKey = "key-a";
    let holdDeepseek = false;
    let heldStarted = false;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("api.deepseek.com")) {
        return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      }
      return codexBody(15);
    }) as typeof fetch;
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.provider === "deepseek" && holdDeepseek) {
        heldStarted = true;
        return { apiKey: "test-key", baseUrl: model.baseUrl, wait: gate };
      }
      return { apiKey: currentKey, source: "stored" };
    };
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      auth,
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const activation = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, activation.ctx);

    const fake = fakeContext({ model: cpa, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    holdDeepseek = true;
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => heldStarted);
    // The active provider's own snapshot is already collected.
    assert.equal(calls.length, 1);

    // Rotate the active credential; an interval refresh reconciles the new
    // source without a logical-model switch while the report still waits.
    currentKey = "key-b";
    await host.refreshActive(fake.ctx, { reason: "interval" });
    const callsAfterRotation = calls.length;
    assert.equal(callsAfterRotation, 2);

    release?.();
    await pending;
    assert.equal(calls.length, callsAfterRotation);
    assert.equal(fake.widgets.length, 0);
    assert.equal(fake.notifications.length, 0);
    host.shutdown(activation.ctx);
  });

  it("stops a report when the active credential rotates while another provider's request is pending", async () => {
    let currentKey = "key-a";
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
    const auth = (): FakeAuth => ({ apiKey: currentKey, source: "stored" });
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      auth,
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const activation = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, activation.ctx);

    const fake = fakeContext({ model: cpa, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.some((url) => url.includes("api.deepseek.com")));

    // The pending provider answer belongs to the rotated source and must not be
    // published under it.
    currentKey = "key-b";
    await host.refreshActive(fake.ctx, { reason: "interval" });
    release?.();
    await pending;
    assert.equal(fake.widgets.length, 0);
    assert.equal(fake.notifications.length, 0);
    host.shutdown(activation.ctx);
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

  it("discards a pending report credential resolution after an unreported route change", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldStarted = false;
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("api.deepseek.com")) return jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] });
      return codexBody(15);
    }) as typeof fetch;
    const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
      if (model.provider === "deepseek") {
        heldStarted = true;
        return { apiKey: "test-key", baseUrl: model.baseUrl, wait: gate };
      }
      return { apiKey: "test-key", baseUrl: model.baseUrl };
    };
    const cpa = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const cpaMoved = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://b.example.com/v1" });
    const deepseek = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [cpa, deepseek],
      auth,
      config: normalizeConfig({ providers: { deepseek: { enabled: true } } }),
    });
    const activation = fakeContext({ model: cpa, registry, mode: "rpc" });
    await pi.emit("model_select", { type: "model_select", model: cpa, previousModel: undefined, source: "set" }, activation.ctx);

    const selection = { current: cpa };
    const fake = fakeContext({ modelRef: selection, registry });
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);
    const pending = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => heldStarted);
    assert.equal(calls.length, 1);

    // The active provider's snapshot is already collected while the next
    // provider's credential resolution is still pending.
    selection.current = cpaMoved;
    release?.();
    await pending;
    assert.equal(calls.length, 1);
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

/**
 * The five routing changes Pi can apply to a selected model without emitting
 * `model_select`: its model equality check compares provider, model id, and
 * type only. Each differs from the bound route in base URL, API, credential, or
 * account routing, so none may publish or start a request after the fact.
 */
const SILENT_ROUTING_CHANGES: Record<string, (model: ReturnType<typeof fakeModel>) => ReturnType<typeof fakeModel>> = {
  "base URL": (model) => ({ ...model, baseUrl: "https://b.example/v1" }),
  API: (model) => ({ ...model, api: "openai-completions" }),
  authorization: (model) => modelWithHeaders(model, { ...model.headers, Authorization: "Bearer synthetic-b" }),
  "account header": (model) => modelWithHeaders(model, { ...model.headers, "ChatGPT-Account-Id": "b" }),
  "null suppression": (model) => modelWithHeaders(model, { ...model.headers, Authorization: null }),
};

/** A model-routing header map that can carry an explicit `null` suppression. */
function modelWithHeaders(
  model: ReturnType<typeof fakeModel>,
  headers: Record<string, string | null>,
): ReturnType<typeof fakeModel> {
  return { ...model, headers } as unknown as ReturnType<typeof fakeModel>;
}

/** The four asynchronous boundaries the host crosses between capture and publication. */
const HELD_BOUNDARIES = [
  { name: "active authentication", stage: "auth", active: true },
  { name: "active GET", stage: "get", active: true },
  { name: "peer authentication", stage: "auth", active: false },
  { name: "peer GET", stage: "get", active: false },
] as const;

describe("host routing binding", () => {
  for (const boundary of HELD_BOUNDARIES) {
    for (const [route, change] of Object.entries(SILENT_ROUTING_CHANGES)) {
      it(`stops a silent ${route} change made while ${boundary.name} is pending`, async () => {
        const active = fakeModel({
          provider: "cpa",
          id: "chat",
          baseUrl: "https://a.example/v1",
          headers: { Authorization: "Bearer synthetic-a", "ChatGPT-Account-Id": "a" },
        });
        const peer = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let armed = false;
        let reached = false;
        const auth = (model: ReturnType<typeof fakeModel>): FakeAuth => {
          const hold = armed && boundary.stage === "auth" && model.provider === (boundary.active ? active.provider : peer.provider);
          if (hold) reached = true;
          return {
            apiKey: "synthetic",
            headers: model.headers,
            baseUrl: model.baseUrl,
            ...(hold ? { wait: gate } : {}),
          };
        };
        const calls: string[] = [];
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
          assert.equal(init?.method, "GET");
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          calls.push(url);
          const hold = boundary.stage === "get" && url.includes(boundary.active ? "a.example" : "api.deepseek.com");
          if (hold) {
            reached = true;
            await gate;
          }
          return url.includes("api.deepseek.com")
            ? jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "3" }] })
            : codexBody(42);
        }) as typeof fetch;
        const { pi, host, registry } = buildHost({
          fetchImpl,
          models: [active, peer],
          timers: false,
          auth,
          config: normalizeConfig({ autoRefresh: false, providers: { deepseek: { enabled: true } } }),
        });
        const selection = { current: active };
        const fake = fakeContext({ modelRef: selection, registry });
        await host.activate(fake.ctx, active, { refresh: false });
        armed = true;
        const pending = host.report(fake.ctx as unknown as ExtensionCommandContext, "");
        await waitFor(() => reached);
        const before = { calls: calls.length, statuses: fake.statuses.length };

        selection.current = change(active);
        release?.();
        await pending;

        assert.equal(calls.length, before.calls, "the old route issues no follow-on request");
        assert.equal(fake.statuses.length, before.statuses, "the old route paints no footer");
        assert.equal(pi.entries.length + fake.widgets.length + fake.notifications.length, 0, "the old route publishes no report");
        host.shutdown(fake.ctx);
      });
    }
  }

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

  it("keeps the captured route and resolver input when the selected model is mutated in place", async () => {
    const model = fakeModel({
      provider: "cpa",
      id: "chat",
      baseUrl: "http://a.example.com/v1",
      headers: { Authorization: "Bearer synthetic-a" },
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beforeWait: string[] = [];
    const afterWait: string[] = [];
    const registry = {
      async getApiKeyAndHeaders(input: typeof model) {
        const seen = () => `${input.baseUrl} ${input.headers?.Authorization ?? "-"}`;
        beforeWait.push(seen());
        await gate;
        // The resolver still reads the captured copy after the live object changed.
        afterWait.push(seen());
        return { ok: true as const, apiKey: "key-a", headers: input.headers, baseUrl: input.baseUrl };
      },
      getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
      isUsingOAuth: () => false,
      getAvailable: () => [model],
      getAll: () => [model],
    } as unknown as ModelRegistry;
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const pi = fakePi();
    const host = new UniversalUsageHost(pi.api, {
      monitor: new UsageMonitor({ now: () => 1_768_000_000_000, fetchImpl, policy: { timeoutMs: 200 } }),
      now: () => 1_768_000_000_000,
      config: normalizeConfig({ refreshSeconds: 300 }),
      timers: false,
    });
    const selection = { current: model };
    const fake = fakeContext({ modelRef: selection, registry });

    const pending = host.activate(fake.ctx, model);
    await waitFor(() => beforeWait.length === 1);
    // Pi can reconfigure the selected object instead of replacing it.
    model.baseUrl = "http://b.example.com/v1";
    model.headers = { Authorization: "Bearer synthetic-b" };
    release?.();
    await pending;

    assert.deepEqual(beforeWait, ["http://a.example.com/v1 Bearer synthetic-a"]);
    assert.deepEqual(afterWait, ["http://a.example.com/v1 Bearer synthetic-a"]);
    assert.equal(calls.length, 0);
    assert.deepEqual(fake.statuses, ["cpa: checking usage..."]);
    host.shutdown(fake.ctx);
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
    const interval = host.refreshActive(fake.ctx, { reason: "interval" });
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

  it("stops a reselection when its authority expires before the caller resumes", async () => {
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://a.example.com/v1" });
    const { fetchImpl, calls } = sequenceFetch([codexBody(12)]);
    const pi = fakePi();
    const host = new UniversalUsageHost(pi.api, {
      monitor: new UsageMonitor({ now: () => 1_768_000_000_000, fetchImpl, policy: { timeoutMs: 200 } }),
      now: () => 1_768_000_000_000,
      config: normalizeConfig({ refreshSeconds: 300, autoRefresh: false }),
      timers: false,
    });
    let armed = false;
    let shutDown = false;
    // `isUsingOAuth` is the last registry call of an auth resolution, so two
    // microtask hops place the shutdown after resolver adoption but before the
    // reselection's own continuation resumes.
    const registry = {
      async getApiKeyAndHeaders(input: typeof model) {
        return { ok: true as const, apiKey: "key-a", headers: input.headers, baseUrl: input.baseUrl };
      },
      getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
      isUsingOAuth: () => {
        if (armed) {
          armed = false;
          queueMicrotask(() =>
            queueMicrotask(() => {
              shutDown = true;
              host.shutdown(fake.ctx);
            }),
          );
        }
        return false;
      },
      getAvailable: () => [model],
      getAll: () => [model],
    } as unknown as ModelRegistry;
    const fake = fakeContext({ model, registry, mode: "tui", idle: false });
    // Installed Pi rejects every access to a context whose session is gone.
    Object.defineProperty(fake.ctx, "mode", {
      configurable: true,
      get() {
        if (shutDown) throw new Error("STALE CONTEXT mode");
        return "tui";
      },
    });
    host.register();

    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, fake.ctx);
    const attribution = (host as unknown as { passiveAttribution?: unknown }).passiveAttribution;
    assert.notEqual(attribution, undefined, "the turn seeded a passive attribution");
    const statusesBeforeReselection = fake.statuses.length;

    armed = true;
    // A same-model reselection adopts its resolution, then resumes one boundary
    // later; the shutdown in between revokes it before it may act.
    await pi.emit("model_select", { type: "model_select", model, previousModel: model, source: "set" }, fake.ctx);

    assert.equal(shutDown, true, "the shutdown landed between adoption and continuation");
    assert.equal(
      (host as unknown as { passiveAttribution?: unknown }).passiveAttribution,
      undefined,
      "no attribution is restored after shutdown",
    );
    assert.equal(fake.statuses.length, statusesBeforeReselection + 1, "only shutdown cleared the footer");
    assert.equal(fake.statuses[fake.statuses.length - 1], undefined);
    assert.equal(fake.widgets.length, 0);
    assert.equal(pi.entries.length, 0);
    assert.equal(calls.length, 0);
  });

  it("starts a replacement request after rotating back to a credential whose run was cancelled", async () => {
    let currentKey = "key-a";
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const calls: Array<string | undefined> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Headers(init?.headers as Record<string, string>).get("authorization") ?? undefined);
      const index = calls.length;
      if (index === 1) await firstGate;
      if (index === 2) await secondGate;
      return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: String(index * 11) }] });
    }) as typeof fetch;
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const { pi, host, registry } = buildHost({
      fetchImpl,
      models: [model],
      auth: () => ({ apiKey: currentKey, source: "stored" }),
      timers: false,
      config: normalizeConfig({ autoRefresh: false }),
    });
    const fake = fakeContext({ model, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    const command = pi.commands.get(COMMAND_NAME);
    assert.ok(command);

    // Credential A's request is held.
    const first = command.handler("", fake.ctx as unknown as ExtensionCommandContext);
    await waitFor(() => calls.length === 1);
    assert.equal(calls[0], "Bearer key-a");

    // Rotate to B: the host aborts A through the work controller's signal.
    currentKey = "key-b";
    const second = host.refreshActive(fake.ctx, { reason: "interval" });
    await waitFor(() => calls.length === 2);
    assert.equal(calls[1], "Bearer key-b");

    // Rotate back to A while both older responses are still pending.
    currentKey = "key-a";
    const third = host.refreshActive(fake.ctx, { reason: "interval", force: true });
    await waitFor(() => calls.length === 3);
    assert.equal(calls[2], "Bearer key-a");
    const snapshot = await third;
    assert.equal(snapshot?.status, "ok");
    const footer = String(fake.statuses[fake.statuses.length - 1]);
    assert.match(footer, /USD \$33/);
    assert.doesNotMatch(footer, /cancelled|error/);

    // The cancelled runs completing late change neither the view nor the requests.
    const statusesAfterReplacement = fake.statuses.length;
    releaseFirst?.();
    releaseSecond?.();
    await Promise.all([first, second]);
    assert.equal(fake.statuses.length, statusesAfterReplacement);
    assert.match(String(fake.statuses[fake.statuses.length - 1]), /USD \$33/);
    assert.equal(calls.length, 3);
    host.shutdown(fake.ctx);
  });
});
