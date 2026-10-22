import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kimiJsonParser } from "../src/parsers/kimi.ts";

const NOW = 1_768_000_000_000;

describe("kimi-json", () => {
  it("drops a percentage that overflows from finite operands", () => {
    const result = kimiJsonParser.parse({ now: NOW, json: { usage: { limit: 1e-308, used: 1e308 } } });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, undefined);
    assert.equal(result.metrics[0]?.limit, 1e-308);
    assert.equal(result.metrics[0]?.used, 1e308);
    assert.match(result.notice ?? "", /cannot be expressed as a percentage/);
  });

  it("parses the plan allowance and a duration-stated rolling window", () => {
    const result = kimiJsonParser.parse({
      now: NOW,
      json: {
        usage: { limit: "1000", used: "250", remaining: "750", resetTime: "2026-01-20T00:00:00Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "40", remaining: "60" },
          },
        ],
      },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 2);
    assert.equal(result.metrics[0]?.label, "plan allowance");
    assert.equal(result.metrics[0]?.usedPercent, 25);
    assert.equal(result.metrics[0]?.resetAtSeconds, Date.parse("2026-01-20T00:00:00Z") / 1000);
    assert.equal(result.metrics[1]?.label, "5h window");
    assert.equal(result.metrics[1]?.durationSeconds, 18000);
    assert.equal(result.metrics[1]?.usedPercent, 40);
  });

  it("derives the missing side only from a valid limit and counterpart", () => {
    const result = kimiJsonParser.parse({ now: NOW, json: { usage: { limit: 100, remaining: 30 } } });
    assert.ok(result);
    assert.equal(result.metrics[0]?.used, 70);
    assert.equal(result.metrics[0]?.usedPercent, 70);
  });

  it("drops a bucket whose used value is present but not numeric", () => {
    const result = kimiJsonParser.parse({
      now: NOW,
      json: {
        usage: { limit: 100, used: "many" },
        limits: [{ window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 10, used: 2 } }],
      },
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.label), ["1h window"]);
    assert.match(result.notice ?? "", /plan allowance has no usable quota values/);
  });

  it("does not invent a window label when no duration is stated", () => {
    const result = kimiJsonParser.parse({ now: NOW, json: { limits: [{ detail: { limit: 5, used: 1 } }] } });
    assert.ok(result);
    assert.equal(result.metrics[0]?.label, "window 1");
    assert.equal(result.metrics[0]?.durationSeconds, undefined);
  });

  it("does not match payloads with no quota values", () => {
    assert.equal(kimiJsonParser.detect({ json: { usage: {}, limits: [] }, now: NOW }), false);
  });
});
