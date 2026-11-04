import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConfig } from "../src/config.ts";
import { UsageView } from "../src/usage-view.ts";
import type { TargetSnapshot } from "../src/types.ts";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

const snapshot = (provider: string): TargetSnapshot => ({
  identity: { key: provider, providerId: provider, modelId: "model", origin: "", basePath: "/", authSource: "unknown", isOAuth: false },
  status: "ok", source: "http", fetchedAt: 0,
  metrics: [{ id: "window", kind: "subscription-window", label: "weekly", source: "codex-json", usedPercent: 40, resetAtSeconds: 120 }],
});

test("view scrolls narrow reports, refreshes only on request, and ignores late results after close", async () => {
  let renders = 0, calls = 0, closed = 0;
  const pending: Array<(v: TargetSnapshot[]) => void> = [];
  const tui = { terminal: { rows: 12 }, requestRender: () => { renders++; } } as unknown as TUI;
  const view = new UsageView(tui, () => { closed++; }, () => { calls++; return new Promise((resolve) => pending.push(resolve)); }, () => normalizeConfig({}), () => 0);
  view.refresh();
  assert.match(view.render(32).join("\n"), /Loading/);
  pending[0]!([snapshot("first"), snapshot("second"), snapshot("third")]);
  await Promise.resolve();
  assert.match(view.render(32).join("\n"), /first/);
  assert.match(view.render(32).join("\n"), /\[####------\]/);
  // Leave room for Pi's surrounding spacing, footer and status.
  assert.ok(view.render(32).length <= 12 - 4);
  assert.match(view.render(32).at(-1)!, /^Up\/Down scroll/);
  view.handleInput("\u001b[F");
  assert.match(view.render(32).join("\n"), /third/);
  assert.equal(calls, 1);
  view.handleInput("r");
  assert.equal(calls, 2);
  view.handleInput("\u001b");
  const before = renders;
  pending[1]!([snapshot("late")]);
  await Promise.resolve();
  assert.equal(renders, before);
  assert.equal(closed, 1);
  view.close();
  assert.equal(closed, 1);
});

test("view sanitizes labels, fits terminal widths, reports failures, and ticks without fetching", async () => {
  let calls = 0, renders = 0, now = 0;
  const tui = { terminal: { rows: 12 }, requestRender: () => { renders++; } } as unknown as TUI;
  const value = snapshot("wide界");
  value.metrics[0]!.label = "weekly\u001b[31m";
  const view = new UsageView(tui, () => {}, async () => {
    calls++;
    if (calls > 1) throw new Error("secret");
    return [value];
  }, () => normalizeConfig({}), () => now);
  view.refresh();
  await Promise.resolve();
  for (const width of [32, 80]) {
    const lines = view.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\u001b")));
    assert.match(lines.join("\n"), /resets in 2m/);
  }
  const before = renders;
  now = 60_000;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(renders > before);
  assert.equal(calls, 1);
  assert.match(view.render(80).join("\n"), /resets in 1m/);
  view.handleInput("r");
  await Promise.resolve();
  assert.match(view.render(80).join("\n"), /Refresh failed/);
  assert.doesNotMatch(view.render(80).join("\n"), /secret/);
  view.dispose();
  const afterDispose = renders;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(renders, afterDispose);
  assert.equal(calls, 2);
});
