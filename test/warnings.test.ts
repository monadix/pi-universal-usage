import assert from "node:assert/strict";
import { it } from "node:test";
import { normalizeConfig } from "../src/config.ts";
import { anthropicHeadersParser, anthropicJsonParser } from "../src/parsers/anthropic.ts";
import type { TargetSnapshot, UsageMetric } from "../src/types.ts";
import { UsageWarnings } from "../src/warnings.ts";

const now = 1_768_000_000_000;
const config = normalizeConfig({});
const metric = (usedPercent: number, overrides: Partial<UsageMetric> = {}): UsageMetric => ({
  id: "codex.primary", kind: "subscription-window", label: "weekly", usedPercent,
  resetAtSeconds: now / 1000 + 600, source: "codex-json", ...overrides,
});
const snapshot = (metrics: UsageMetric[], overrides: Partial<TargetSnapshot> = {}): TargetSnapshot => ({
  identity: { key: "hash-a", providerId: "codex", modelId: "model", origin: "", basePath: "/", authSource: "stored", isOAuth: true },
  status: "ok", metrics, fetchedAt: now, source: "http", ...overrides,
});

it("warns initially, on crossings and jumps, once per identity, dimension and reset", () => {
  const warnings = new UsageWarnings();
  const observe = (s: TargetSnapshot) => warnings.observe(s, config, now);
  assert.equal(observe(snapshot([metric(89)])).length, 0);
  assert.equal(observe(snapshot([metric(91)])).length, 1);
  assert.equal(observe(snapshot([metric(91)])).length, 0);
  assert.equal(observe(snapshot([metric(100)])).length, 1);
  assert.equal(observe(snapshot([metric(100)])).length, 0);
  assert.equal(observe(snapshot([metric(100, { id: "second" })])).length, 2);
  assert.equal(observe(snapshot([metric(100, { resetAtSeconds: now / 1000 + 1200 })])).length, 2);
  const other = snapshot([metric(100)]);
  other.identity = { ...other.identity, key: "hash-b" };
  assert.equal(observe(other).length, 2);
  const later = now + 601_000;
  assert.equal(warnings.observe(snapshot([metric(100, { resetAtSeconds: later / 1000 + 600 })], { fetchedAt: later }), config, later).length, 2);
  warnings.clear();
  assert.equal(observe(snapshot([metric(100)])).length, 2);
});

it("deduplicates equivalent Anthropic JSON and header windows without merging model windows", () => {
  const reset = now / 1000 + 600;
  const isoReset = new Date(reset * 1000).toISOString();
  const json = anthropicJsonParser.parse({ now, json: {
    five_hour: { utilization: 95, resets_at: isoReset },
    seven_day: { utilization: 95, resets_at: isoReset },
    seven_day_opus: { utilization: 95, resets_at: isoReset },
    seven_day_sonnet: { utilization: 95, resets_at: isoReset },
  } });
  const headers = anthropicHeadersParser.parse({ now, headers: {
    "anthropic-ratelimit-unified-5h-utilization": "0.95",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-7d-utilization": "0.95",
    "anthropic-ratelimit-unified-7d-reset": String(reset),
  } });
  assert.ok(json);
  assert.ok(headers);
  const fromJson = snapshot(json.metrics);
  const fromHeaders = snapshot(headers.metrics, { source: "headers" });
  for (const [first, second] of [[fromJson, fromHeaders], [fromHeaders, fromJson]] as const) {
    const warnings = new UsageWarnings();
    assert.equal(warnings.observe(first, config, now).length, first.metrics.length);
    assert.equal(warnings.observe(second, config, now).length, first === fromJson ? 0 : 2);
    assert.equal(warnings.observe(fromJson, config, now).length, 0);
    const changedIdentity = { ...fromHeaders, identity: { ...fromHeaders.identity, key: "hash-b" } };
    assert.equal(warnings.observe(changedIdentity, config, now).length, 2);
    const newWindow: TargetSnapshot = { ...fromHeaders, metrics: headers.metrics.map((value) => ({ ...value, resetAtSeconds: reset + 1 })) };
    assert.equal(warnings.observe(newWindow, config, now).length, 2);
    const crossed: TargetSnapshot = { ...fromHeaders, metrics: headers.metrics.map((value) => ({ ...value, usedPercent: 100 })) };
    assert.equal(warnings.observe(crossed, config, now).length, 2);
    assert.equal(warnings.observe(crossed, config, now).length, 0);
  }
});

it("suppresses stale, unknown, elapsed, nonfinite and non-subscription observations", () => {
  const warnings = new UsageWarnings();
  const invalid = [metric(100, { resetAtSeconds: undefined }), metric(100, { resetAtSeconds: now / 1000 }),
    metric(NaN), metric(Infinity), metric(100, { resetAtSeconds: Infinity }),
    metric(100, { kind: "budget" }), metric(100, { kind: "balance" }),
    metric(100, { kind: "token-limit" }), metric(100, { kind: "request-limit" }),
    metric(100, { source: "rate-limit-headers" })];
  assert.deepEqual(warnings.observe(snapshot(invalid), config, now), []);
  assert.deepEqual(warnings.observe(snapshot([metric(100)], { fetchedAt: now - 600_001 }), config, now), []);
  assert.deepEqual(warnings.observe(snapshot([metric(100)], { status: "rate-limited" }), config, now), []);
  assert.deepEqual(warnings.observe(snapshot([metric(100)]), normalizeConfig({ warnings: false }), now), []);
  assert.equal(warnings.observe(snapshot([metric(100)]), config, now).length, 2);
});

it("validates warning settings and normalizes configured thresholds", () => {
  assert.deepEqual(config.warningThresholds, [90, 100]);
  assert.equal(config.warnings, true);
  assert.deepEqual(normalizeConfig({ warningThresholds: [100, 80, 80] }).warningThresholds, [80, 100]);
  for (const value of [[], [0], [101], [NaN], ["90"], "90"]) {
    const parsed = normalizeConfig({ warningThresholds: value, warnings: "yes" });
    assert.deepEqual(parsed.warningThresholds, [90, 100]);
    assert.equal(parsed.warnings, true);
    assert.equal(parsed.problems.length, 2);
  }
});
