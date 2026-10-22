import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zaiJsonParser } from "../src/parsers/zai.ts";

const NOW = 1_768_000_000_000;

function envelope(limits: unknown[], extra: Record<string, unknown> = {}) {
  return { code: 200, success: true, data: { limits }, ...extra };
}

describe("zai-json", () => {
  it("parses token windows from percentage and reports the unit/number pair verbatim", () => {
    const result = zaiJsonParser.parse({
      now: NOW,
      json: envelope([
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, usage: 1000, currentValue: 420, nextResetTime: 1_768_003_600_000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 10, usage: 5000, currentValue: 500 },
      ]),
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 2);
    assert.equal(result.metrics[0]?.label, "tokens (unit 3 × 5)");
    assert.equal(result.metrics[0]?.usedPercent, 42);
    assert.equal(result.metrics[0]?.limit, 1000);
    assert.equal(result.metrics[0]?.used, 420);
    assert.equal(result.metrics[0]?.resetAtSeconds, 1_768_003_600);
  });

  it("derives a percent from currentValue/usage only when percentage is absent, and discloses it", () => {
    const result = zaiJsonParser.parse({
      now: NOW,
      json: envelope([{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 200, currentValue: 50 }]),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, 25);
    assert.match(result.notice ?? "", /derived from currentValue\/usage/);
  });

  it("keeps credit and tool allowances in separate scopes", () => {
    const result = zaiJsonParser.parse({
      now: NOW,
      json: envelope([
        { type: "CREDIT_LIMIT", unit: 1, number: 1, percentage: 5, usage: 100, currentValue: 5 },
        { type: "TIME_LIMIT", unit: 4, number: 1, percentage: 50, usage: 10, currentValue: 5 },
      ]),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.kind, "budget");
    assert.equal(result.metrics[0]?.scope, "plan");
    assert.equal(result.metrics[1]?.scope, "tools");
    assert.equal(result.metrics[1]?.label, "tool allowance (unit 4 × 1)");
  });

  it("rejects an explicitly failed envelope even when it carries limits", () => {
    const limits = [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 }];
    assert.equal(zaiJsonParser.parse({ now: NOW, json: { code: 500, success: false, data: { limits } } }), undefined);
    assert.equal(zaiJsonParser.parse({ now: NOW, json: { code: 500, success: true, data: { limits } } }), undefined);
  });

  it("rejects a reset timestamp that is not the documented epoch milliseconds", () => {
    const result = zaiJsonParser.parse({
      now: NOW,
      json: envelope([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1_768_003_600 }]),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.resetAtSeconds, undefined);
  });

  it("drops a negative percentage instead of clamping it to zero", () => {
    const result = zaiJsonParser.parse({
      now: NOW,
      json: envelope([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: -5, usage: 100, currentValue: 10 }]),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, undefined);
    assert.match(result.notice ?? "", /percentage is negative/);
    assert.doesNotMatch(result.notice ?? "", /derived/);
  });

  it("drops a derived percentage that overflows from finite operands", () => {
    const result = zaiJsonParser.parse({
      now: NOW,
      json: envelope([{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1e-308, currentValue: 1e308 }]),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, undefined);
    assert.equal(result.metrics[0]?.limit, 1e-308);
    assert.equal(result.metrics[0]?.used, 1e308);
    assert.match(result.notice ?? "", /cannot be represented/);
  });

  it("ignores unknown limit types and non-quota payloads", () => {
    assert.equal(zaiJsonParser.detect({ json: envelope([{ type: "MYSTERY_LIMIT", percentage: 1 }]), now: NOW }), false);
    assert.equal(zaiJsonParser.parse({ now: NOW, json: envelope([{ type: "MYSTERY_LIMIT", percentage: 1 }]) }), undefined);
  });
});
