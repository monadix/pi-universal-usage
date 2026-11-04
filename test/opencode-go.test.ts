import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { opencodeGoJsonParser } from "../src/parsers/opencode-go.ts";

const NOW = 1_768_000_000_000;
const ROLLING_RESET = "2026-11-04T22:02:10.000Z";
const WEEKLY_RESET = "2026-11-09T00:00:00.000Z";
const MONTHLY_RESET = "2026-12-04T16:42:05.000Z";

function usage(windows: Record<string, unknown>) {
  return { usage: windows };
}

describe("opencode-go-json", () => {
  it("reads consumed percentages in percentage units and ISO reset timestamps", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({
        rolling: { status: "ok", percent: 0, resetsAt: ROLLING_RESET },
        weekly: { status: "ok", percent: 42.5, resetsAt: WEEKLY_RESET },
        monthly: { status: "ok", percent: 100, resetsAt: MONTHLY_RESET },
      }),
    });
    assert.ok(result);
    assert.equal(result.scheme, "opencode-go-json");
    assert.deepEqual(result.metrics.map((metric) => metric.id), [
      "opencode-go.rolling",
      "opencode-go.weekly",
      "opencode-go.monthly",
    ]);
    assert.deepEqual(result.metrics.map((metric) => metric.usedPercent), [0, 42.5, 100]);
    assert.deepEqual(result.metrics.map((metric) => metric.resetAtSeconds), [
      Date.parse(ROLLING_RESET) / 1000,
      Date.parse(WEEKLY_RESET) / 1000,
      Date.parse(MONTHLY_RESET) / 1000,
    ]);
    // Percentage units are direct: 0.5 is half a percent, never a 0.5 fraction.
    assert.equal(result.notice, undefined);
  });

  it("does not reinterpret a percent at or below 1 as a 0..1 fraction", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({ rolling: { status: "ok", percent: 0.5, resetsAt: ROLLING_RESET } }),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, 0.5);
  });

  it("keeps a zero percent as a measurement and does not invert it into remaining", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({ rolling: { status: "ok", percent: 0, resetsAt: ROLLING_RESET } }),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, 0);
    assert.equal(result.metrics[0]?.remainingPercent, undefined);
  });

  it("preserves over-allocation above 100 instead of clamping it", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({ rolling: { status: "ok", percent: 125 } }),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, 125);
  });

  it("maps a rate-limited window to limit-reached while keeping its percentage", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({
        rolling: { status: "rate-limited", percent: 100, resetsAt: ROLLING_RESET },
        weekly: { status: "ok", percent: 12, resetsAt: WEEKLY_RESET },
      }),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.status, "limit-reached");
    assert.equal(result.metrics[0]?.usedPercent, 100);
    assert.equal(result.metrics[1]?.status, undefined);
  });

  it("skips malformed siblings and omits absent ones without fabricating a value", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({
        rolling: { status: "ok", percent: 10, resetsAt: ROLLING_RESET },
        weekly: { status: "ok", percent: "many", resetsAt: WEEKLY_RESET },
        monthly: { status: "ok", percent: -1, resetsAt: MONTHLY_RESET },
      }),
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.id), ["opencode-go.rolling"]);
    assert.match(result.notice ?? "", /weekly window reports no usable consumed percentage/);
    assert.match(result.notice ?? "", /monthly window reports no usable consumed percentage/);

    const partial = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({
        rolling: { status: "ok", percent: 10, resetsAt: ROLLING_RESET },
        monthly: { status: "ok", percent: 30, resetsAt: MONTHLY_RESET },
      }),
    });
    assert.ok(partial);
    assert.deepEqual(partial.metrics.map((metric) => metric.id), ["opencode-go.rolling", "opencode-go.monthly"]);
    assert.equal(partial.notice, undefined);
  });

  it("leaves an unparseable reset timestamp unknown", () => {
    const result = opencodeGoJsonParser.parse({
      now: NOW,
      json: usage({ rolling: { status: "ok", percent: 5, resetsAt: "not-a-date" } }),
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.resetAtSeconds, undefined);
    assert.equal(result.metrics[0]?.usedPercent, 5);
  });

  it("detects the usage-window envelope but not unrelated usage objects", () => {
    assert.equal(opencodeGoJsonParser.detect({ json: usage({ rolling: { percent: 1 } }), now: NOW }), true);
    assert.equal(opencodeGoJsonParser.detect({ json: usage({ weekly: { status: "ok" } }), now: NOW }), true);
    assert.equal(opencodeGoJsonParser.detect({ json: usage({}), now: NOW }), false);
    assert.equal(opencodeGoJsonParser.detect({ json: { usage: { limit: 10, used: 2 } }, now: NOW }), false);
    assert.equal(opencodeGoJsonParser.detect({ json: { usage: { rolling: "missing" } }, now: NOW }), false);
  });
});
