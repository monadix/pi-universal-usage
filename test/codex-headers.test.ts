import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexHeadersParser } from "../src/parsers/codex-headers.ts";

const NOW = 1_768_000_000_000;

describe("codex-headers", () => {
  it("drops a negative used percent instead of rendering it as zero", () => {
    const result = codexHeadersParser.parse({
      now: 1_768_000_000_000,
      headers: { "x-codex-primary-used-percent": "-5", "x-codex-secondary-used-percent": "12" },
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.id), ["codex.secondary"]);
  });

  it("drops a window duration that overflows after conversion", () => {
    const result = codexHeadersParser.parse({
      now: 1_768_000_000_000,
      headers: {
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-window-minutes": "1e308",
      },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.durationSeconds, undefined);
    assert.equal(result.metrics[0]?.label, "primary window");
  });

  it("reads percent, window, and reset headers for both windows", () => {
    const result = codexHeadersParser.parse({
      now: NOW,
      headers: {
        "x-codex-primary-used-percent": "25",
        "x-codex-primary-window-minutes": "300",
        "X-Codex-Primary-Reset-At": "1768003600",
        "x-codex-secondary-used-percent": "60",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "900",
      },
    });
    assert.ok(result);
    const [primary, secondary] = result.metrics;
    assert.equal(primary?.usedPercent, 25);
    assert.equal(primary?.label, "5h window");
    assert.equal(primary?.durationSeconds, 18000);
    assert.equal(primary?.resetAtSeconds, 1768003600);
    assert.equal(secondary?.label, "7d window");
    assert.equal(secondary?.resetAtSeconds, Math.round(NOW / 1000 + 900));
  });

  it("keeps a credits balance as a separate budget dimension", () => {
    const result = codexHeadersParser.parse({
      now: NOW,
      headers: {
        "x-codex-secondary-used-percent": "10",
        "x-codex-credits-has-credits": "true",
        "x-codex-credits-balance": "4.5",
      },
    });
    assert.ok(result);
    const credits = result.metrics.find((metric) => metric.id === "codex.credits");
    assert.equal(credits?.kind, "budget");
    assert.equal(credits?.remaining, 4.5);
    assert.equal(credits?.unit, "credits");
  });

  it("reports unlimited credits as status, not as a zero balance", () => {
    const result = codexHeadersParser.parse({
      now: NOW,
      headers: { "x-codex-primary-used-percent": "1", "x-codex-credits-unlimited": "true" },
    });
    assert.ok(result);
    assert.equal(result.metrics.find((metric) => metric.id === "codex.credits")?.status, "unlimited");
  });

  it("ignores plan metadata without any quota dimension", () => {
    assert.equal(codexHeadersParser.parse({ now: NOW, headers: { "x-codex-plan-type": "pro" } }), undefined);
    assert.equal(codexHeadersParser.parse({ now: NOW, headers: { "x-codex-primary-used-percent": "n/a" } }), undefined);
  });
});
