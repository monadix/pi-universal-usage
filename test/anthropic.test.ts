import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anthropicHeadersParser, anthropicJsonParser } from "../src/parsers/anthropic.ts";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

describe("anthropic-json", () => {
  it("parses five-hour, weekly, and per-model windows with ISO resets", () => {
    const result = anthropicJsonParser.parse({
      now: NOW,
      json: {
        five_hour: { utilization: 20, resets_at: "2026-01-15T17:00:00Z" },
        seven_day: { utilization: 55.5, resets_at: "2026-01-20T00:00:00Z" },
        seven_day_opus: { utilization: 80, resets_at: "2026-01-20T00:00:00Z" },
      },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 3);
    const [fiveHour, weekly, opus] = result.metrics;
    assert.equal(fiveHour?.label, "5-hour window");
    assert.equal(fiveHour?.durationSeconds, 18000);
    assert.equal(fiveHour?.resetAtSeconds, Date.parse("2026-01-15T17:00:00Z") / 1000);
    assert.equal(weekly?.label, "7-day window");
    assert.equal(weekly?.usedPercent, 55.5);
    assert.equal(opus?.label, "opus 7-day window");
    assert.equal(opus?.scope, "model:opus");
  });

  it("keeps a malformed window as a notice instead of a zero percent", () => {
    const result = anthropicJsonParser.parse({
      now: NOW,
      json: { five_hour: { utilization: "unknown" }, seven_day: { utilization: 10 } },
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.id), ["anthropic.seven_day"]);
    assert.match(result.notice ?? "", /5-hour window reports no usable utilization/);
  });

  it("drops an out-of-domain JSON utilization instead of clamping it", () => {
    const result = anthropicJsonParser.parse({
      now: NOW,
      json: { five_hour: { utilization: -5 }, seven_day: { utilization: 140 }, seven_day_opus: { utilization: 30 } },
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.id), ["anthropic.seven_day_opus"]);
    assert.match(result.notice ?? "", /5-hour window reports no usable utilization/);
    assert.match(result.notice ?? "", /7-day window reports no usable utilization/);
  });

  it("does not match payloads without recognizable windows", () => {
    assert.equal(anthropicJsonParser.detect({ json: { five_hour: null }, now: NOW }), false);
    assert.equal(anthropicJsonParser.detect({ json: { data: { limits: [] } }, now: NOW }), false);
  });
});

describe("anthropic-headers", () => {
  it("scales the 0..1 utilization fraction once and reads epoch resets", () => {
    const result = anthropicHeadersParser.parse({
      now: NOW,
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": "1768003600",
        "anthropic-ratelimit-unified-7d-utilization": "0.01",
        "anthropic-ratelimit-unified-7d-status": "allowed",
      },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 2);
    assert.equal(result.metrics[0]?.usedPercent, 42);
    assert.equal(result.metrics[0]?.resetAtSeconds, 1768003600);
    assert.equal(result.metrics[1]?.usedPercent, 1);
    assert.equal(result.metrics[1]?.status, "allowed");
  });

  it("reports a rejected status as a rate limit", () => {
    const result = anthropicHeadersParser.parse({
      now: NOW,
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-status": "rejected",
      },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.status, "rejected");
    assert.equal(result.rateLimited, true);
  });

  it("recognizes an overall rejected status even without a window", () => {
    const result = anthropicHeadersParser.parse({
      now: NOW,
      headers: { "anthropic-ratelimit-unified-status": "rejected" },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 0);
    assert.equal(result.rateLimited, true);
  });

  it("rejects a utilization header outside the documented 0..1 fraction", () => {
    const result = anthropicHeadersParser.parse({
      now: NOW,
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": "42",
        "anthropic-ratelimit-unified-5h-reset": "1768003600",
      },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, undefined);
    assert.equal(result.metrics[0]?.resetAtSeconds, 1768003600);
    assert.match(result.notice ?? "", /outside the documented 0\.\.1 range/);
  });

  it("does not treat a 0..100 JSON utilization as a header fraction", () => {
    assert.equal(anthropicHeadersParser.detect({ headers: { "content-type": "application/json" }, now: NOW }), false);
  });
});
