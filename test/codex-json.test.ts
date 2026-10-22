import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexJsonParser } from "../src/parsers/codex-json.ts";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function parse(json: unknown) {
  return codexJsonParser.parse({ json, now: NOW });
}

describe("codex-json", () => {
  it("parses both windows with percent, duration, and epoch reset", () => {
    const result = parse({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1_768_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 3600 },
      },
    });
    assert.ok(result);
    assert.equal(result.scheme, "codex-json");
    const [primary, secondary] = result.metrics;
    assert.equal(primary.id, "codex.primary");
    assert.equal(primary.label, "5h window");
    assert.equal(primary.usedPercent, 12.5);
    assert.equal(primary.durationSeconds, 18000);
    assert.equal(primary.resetAtSeconds, 1_768_000_000);
    assert.equal(secondary.label, "7d window");
    assert.equal(secondary.usedPercent, 40);
    assert.equal(secondary.resetAtSeconds, Math.round(NOW / 1000 + 3600));
    assert.match(result.notice ?? "", /plan=pro/);
  });

  it("accepts a weekly-only response with a null primary window (CPA shape)", () => {
    const result = parse({
      plan_type: "unknown",
      quota_mode: "shadow",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: null,
        secondary_window: { used_percent: 73, limit_window_seconds: 604800, reset_after_seconds: 120 },
      },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0]?.id, "codex.secondary");
    assert.equal(result.metrics[0]?.usedPercent, 73);
    assert.match(result.notice ?? "", /quota_mode=shadow/);
    assert.match(result.notice ?? "", /not enforced/);
  });

  it("marks a limit-reached window without inventing other windows", () => {
    const result = parse({
      rate_limit: { limit_reached: true, allowed: false, secondary_window: { used_percent: 100 } },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0]?.status, "limit-reached");
    assert.equal(result.rateLimited, true);
    assert.equal(result.metrics[0]?.label, "secondary window");
  });

  it("skips a window with a malformed used_percent and keeps its sibling", () => {
    const result = parse({
      rate_limit: {
        primary_window: { used_percent: "not-a-number", limit_window_seconds: 18000 },
        secondary_window: { used_percent: 10 },
      },
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.id), ["codex.secondary"]);
    assert.match(result.notice ?? "", /primary window reports no usable used_percent/);
  });

  it("returns undefined when no window carries a measurement", () => {
    assert.equal(parse({ rate_limit: { primary_window: null, secondary_window: null } }), undefined);
  });

  it("does not treat an unrelated JSON body as a codex payload", () => {
    assert.equal(codexJsonParser.detect({ json: { rate_limit: "weekly", status: "ok" }, now: NOW }), false);
    assert.equal(codexJsonParser.detect({ json: { objects: [] }, now: NOW }), false);
  });
});
