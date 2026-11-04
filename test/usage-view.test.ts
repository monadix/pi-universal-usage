import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageView } from "../src/usage-view.ts";
import { deepseekBalanceParser } from "../src/parsers/deepseek.ts";
import type { TargetSnapshot, UsageMetric } from "../src/types.ts";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

const snapshot = (provider: string): TargetSnapshot => ({
  identity: { key: provider, providerId: provider, modelId: "model", origin: "", basePath: "/", authSource: "unknown", isOAuth: false },
  status: "ok", source: "http", fetchedAt: 0,
  metrics: [{ id: "window", kind: "subscription-window", label: "weekly", source: "codex-json", usedPercent: 40, resetAtSeconds: 120 }],
});
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture(collect: () => Promise<TargetSnapshot[] | undefined>, rows = 12) {
  let renders = 0, closed = 0, now = 0;
  const notifications: string[] = [];
  const tui = { terminal: { rows }, requestRender: () => { renders++; } } as unknown as TUI;
  const view = new UsageView(tui, () => { closed++; }, collect, () => now, (message) => notifications.push(message));
  return { view, notifications, renders: () => renders, closed: () => closed, setNow: (value: number) => { now = value; } };
}

test("view scrolls all narrow rows, coalesces r, and ignores late results after Esc", async () => {
  let calls = 0;
  const pending: Array<(v: TargetSnapshot[]) => void> = [];
  const f = fixture(() => { calls++; return new Promise((resolve) => pending.push(resolve)); });
  f.view.refresh();
  assert.match(f.view.render(30).join("\n"), /Loading/);
  await settle();
  pending[0]!([snapshot("first"), snapshot("second"), snapshot("third")]);
  await settle();
  assert.match(f.view.render(30).join("\n"), /first/);
  assert.match(f.view.render(30).join("\n"), /\[####------\]/);
  assert.ok(f.view.render(30).length <= 10);
  assert.match(f.view.render(30).join("\n"), /↑↓ scroll/);
  f.view.handleInput("\u001b[F");
  assert.match(f.view.render(30).join("\n"), /third/);
  f.view.handleInput("\u001b[H");
  assert.match(f.view.render(30).join("\n"), /first/);
  for (const key of ["\u001b[B", "\u001b[A", "\u001b[6~", "\u001b[5~"]) f.view.handleInput(key);
  assert.equal(calls, 1);
  f.view.handleInput("r"); f.view.handleInput("r"); f.view.handleInput("r");
  await settle();
  assert.equal(calls, 2);
  f.view.handleInput("\u001b");
  const before = f.renders();
  pending[1]!([snapshot("late")]);
  await settle();
  assert.equal(f.renders(), before);
  assert.equal(f.closed(), 1);
  f.view.close(); f.view.handleInput("r");
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.notifications, []);
});

test("view fits wide characters, omits diagnostics, only scrolls when needed, and never ticks or fetches from render", async () => {
  let calls = 0;
  const value = snapshot("wide界\u001b[31m");
  value.metrics[0]!.label = "weekly界\u001b[31m";
  value.endpoint = "https://private.invalid/internal";
  value.scheme = "codex-json";
  value.notice = "plan=internal";
  value.error = "secret";
  const f = fixture(async () => { calls++; return [value]; }, 24);
  f.view.refresh(); await settle();
  for (const width of [28, 30, 64, 80]) {
    const lines = f.view.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\u001b")));
    assert.match(lines.join("\n"), /resets/);
    assert.match(lines.join("\n"), /2m/);
    assert.match(lines.join("\n"), /r refresh · Esc close/);
    assert.doesNotMatch(lines.join("\n"), /age:|stale|freshness|source|state:|codex-json|private|internal|plan=|secret|scroll/i);
  }
  const before = f.renders();
  f.setNow(60_000);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.renders(), before, "no one-second redraw timer");
  assert.equal(calls, 1);
  assert.match(f.view.render(64).join("\n"), /resets in 1m/);
  assert.equal(calls, 1);
  assert.equal(f.closed(), 0, "useful results do not auto-close");
  f.view.dispose();
});

for (const initial of [true, false]) {
  test(`all-unavailable ${initial ? "initial" : "manual refresh"} closes once with a safe reason`, async () => {
    const empty = { ...snapshot("cpa\u001b[31m"), status: "unsupported" as const, metrics: [], error: "secret" };
    let calls = 0;
    const f = fixture(async () => !initial && ++calls === 1 ? [snapshot("good")] : [empty]);
    f.view.refresh(); await settle();
    if (!initial) { assert.equal(f.closed(), 0); f.view.handleInput("r"); await settle(); }
    assert.equal(f.closed(), 1);
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0], "Usage unavailable: no quota interface");
    assert.doesNotMatch(f.notifications[0]!, /secret|\u001b/);
    f.view.handleInput("r"); await settle();
    assert.equal(f.notifications.length, 1);
  });
  test(`rejected collection on ${initial ? "initial" : "manual refresh"} closes with one generic notification`, async () => {
    let calls = 0;
    const f = fixture(async () => { if (!initial && ++calls === 1) return [snapshot("good")]; throw new Error("secret"); });
    f.view.refresh(); await settle();
    if (!initial) { f.view.handleInput("r"); await settle(); }
    assert.equal(f.closed(), 1);
    assert.deepEqual(f.notifications, ["Usage unavailable: provider refresh failed"]);
  });
}

test("all-unavailable notifications deduplicate reasons and stay concise for many providers", async () => {
  const f = fixture(async () => Array.from({ length: 20 }, (_, index) => ({
    ...snapshot(`provider-${index}`), status: "unavailable", metrics: [],
  })));
  f.view.refresh(); await settle();
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.notifications, ["Usage unavailable: provider unavailable"]);
});

test("mixed results retain data and a concise unavailable row without diagnostic errors", async () => {
  const f = fixture(async () => [snapshot("good"), { ...snapshot("bad"), status: "error", metrics: [], error: "secret" }], 24);
  f.view.refresh(); await settle();
  const text = f.view.render(64).join("\n");
  assert.match(text, /good/); assert.match(text, /40%/);
  assert.match(text, /bad: unavailable \(refresh failed\)/);
  assert.doesNotMatch(text, /secret/);
  assert.equal(f.closed(), 0); assert.deepEqual(f.notifications, []);
  f.view.close();
});

const base: UsageMetric = { id: "x", kind: "balance", label: "credits", source: "codex-json" };
for (const fields of [{ remaining: 0 }, { used: 0 }, { usedPercent: 0 }, { remainingPercent: 0 }, { limit: 0 }, { status: "unlimited" }, { status: "allowed" }, { status: "limit-reached" }, { status: "rejected" }, { resetAtSeconds: 120 }] as Partial<UsageMetric>[]) {
  test(`meaningful metric ${JSON.stringify(fields)} keeps the overlay open`, async () => {
    const f = fixture(async () => [{ ...snapshot("cpa"), metrics: [{ ...base, ...fields }] }]);
    f.view.refresh(); await settle();
    assert.equal(f.closed(), 0); assert.deepEqual(f.notifications, []);
    assert.match(f.view.render(30).join("\n"), /credits/);
    f.view.close();
  });
}
for (const metrics of [[], [base], [{ ...base, status: "unavailable" as const }], [{ ...base, usedPercent: NaN }]]) {
  test(`status ok without usable metrics closes: ${JSON.stringify(metrics)}`, async () => {
    const f = fixture(async () => [{ ...snapshot("cpa"), metrics }]);
    f.view.refresh(); await settle();
    assert.equal(f.closed(), 1); assert.equal(f.notifications.length, 1);
  });
}

for (const total of ["8.82", "0"]) {
  test(`parsed restricted $${total} balance stays visible with its restriction at both layouts`, async () => {
    const parsed = deepseekBalanceParser.parse({
      now: 0, json: { is_available: false, balance_infos: [{ currency: "USD", total_balance: total }] },
    });
    assert.ok(parsed);
    for (const [width, rows] of [[64, 24], [30, 12]]) {
      const f = fixture(async () => [{ ...snapshot("deepseek"), metrics: parsed.metrics }], rows);
      f.view.refresh(); await settle();
      const pages = [f.view.render(width).join("\n")];
      f.view.handleInput("\u001b[F"); pages.push(f.view.render(width).join("\n"));
      const text = pages.join("\n");
      assert.match(text, /balance availability/); assert.match(text, /unavailable/);
      assert.ok(text.includes(`$${total}`));
      assert.equal(f.closed(), 0); assert.deepEqual(f.notifications, []);
      assert.ok(f.view.render(width).every((line) => visibleWidth(line) <= width));
      f.view.close();
    }
  });
}

for (const initial of [true, false]) {
  test(`parsed unavailable-only balance closes ${initial ? "initial" : "manual refresh"} without fabricating money`, async () => {
    const parsed = deepseekBalanceParser.parse({ now: 0, json: { is_available: false, balance_infos: [] } });
    assert.ok(parsed);
    let calls = 0;
    const f = fixture(async () => !initial && ++calls === 1 ? [snapshot("good")]
      : [{ ...snapshot("deepseek"), metrics: parsed.metrics }]);
    f.view.refresh(); await settle();
    if (!initial) { assert.equal(f.closed(), 0); f.view.handleInput("r"); await settle(); }
    assert.equal(f.closed(), 1);
    assert.deepEqual(f.notifications, ["Usage unavailable: no quota data"]);
    assert.doesNotMatch(f.notifications[0]!, /\$/);
  });
}

test("over-allocated usage remains qualified without extending the bar", async () => {
  const f = fixture(async () => [{ ...snapshot("cpa"), metrics: [{ ...base, usedPercent: 140 }] }], 24);
  f.view.refresh(); await settle();
  const text = f.view.render(64).join("\n");
  assert.match(text, /Reported usage is above 100%/);
  assert.match(text, /\[##########\] used/);
  f.view.close();
});

test("cancellation and disposal never notify or publish late failures", async () => {
  const cancelled = fixture(async () => undefined);
  cancelled.view.refresh(); await settle();
  assert.equal(cancelled.closed(), 1); assert.deepEqual(cancelled.notifications, []);
  let reject!: (error: Error) => void;
  const disposed = fixture(() => new Promise((_resolve, fail) => { reject = fail; }));
  disposed.view.refresh(); await settle();
  disposed.view.dispose(); const renders = disposed.renders();
  reject(new Error("secret")); await settle();
  assert.equal(disposed.renders(), renders); assert.deepEqual(disposed.notifications, []);
});
