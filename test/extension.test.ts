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
    const fake = fakeContext({ model: modelA, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
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
    const fake = fakeContext({ model: modelA, registry });
    await pi.emit("session_start", { type: "session_start" }, fake.ctx);
    await waitFor(() => calls.length === 1);
    assert.match(calls[0]?.url ?? "", /localhost:8317/);

    holdNext = true;
    const older = host.refreshActive(fake.ctx, { reason: "older", force: true, model: modelA });
    await waitFor(() => heldStarted);
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
});
