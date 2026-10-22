import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openrouterJsonParser } from "../src/parsers/openrouter.ts";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // Thursday

describe("openrouter-json", () => {
  it("parses a key budget with a cap, remaining amount, and reset period", () => {
    const result = openrouterJsonParser.parse({
      now: NOW,
      json: { data: { limit: 10, limit_remaining: 2.5, limit_reset: "daily", usage_daily: 1.5 } },
    });
    assert.ok(result);
    const budget = result.metrics.find((metric) => metric.id === "openrouter.key-budget");
    assert.equal(budget?.kind, "budget");
    assert.equal(budget?.limit, 10);
    assert.equal(budget?.remaining, 2.5);
    assert.equal(budget?.used, 7.5);
    assert.equal(budget?.unit, "USD");
    assert.equal(budget?.resetAtSeconds, Date.UTC(2026, 0, 16) / 1000);
  });

  it("keeps an unknown cap unknown and reports spend only", () => {
    const result = openrouterJsonParser.parse({
      now: NOW,
      json: { data: { limit: null, limit_remaining: null, usage: 12.25, usage_daily: 0.5 } },
    });
    assert.ok(result);
    assert.equal(result.metrics.some((metric) => metric.id === "openrouter.key-budget"), false);
    const spend = result.metrics.find((metric) => metric.id === "openrouter.key-spend");
    assert.equal(spend?.used, 0.5);
    assert.equal(spend?.limit, undefined);
  });

  it("keeps account credits separate from the key budget, including an overdrawn balance", () => {
    const result = openrouterJsonParser.parse({
      now: NOW,
      json: { data: { total_credits: 5, total_usage: 7.5 } },
    });
    assert.ok(result);
    const balance = result.metrics.find((metric) => metric.id === "openrouter.account-credits");
    assert.equal(balance?.kind, "balance");
    assert.equal(balance?.scope, "account");
    assert.equal(balance?.remaining, -2.5);
  });

  it("combines a key body with a credits body without merging their scopes", () => {
    const key = openrouterJsonParser.parse({
      now: NOW,
      json: { data: { limit: 20, limit_remaining: 15, limit_reset: "monthly" } },
    });
    const credits = openrouterJsonParser.parse({
      now: NOW,
      json: { data: { total_credits: 100, total_usage: 20 } },
    });
    assert.deepEqual(
      [...(key?.metrics ?? []), ...(credits?.metrics ?? [])].map((metric) => metric.scope),
      ["key", "account"],
    );
  });

  it("keeps a purchased total without fabricating a remaining balance", () => {
    const result = openrouterJsonParser.parse({ now: NOW, json: { data: { total_credits: 100 } } });
    assert.ok(result);
    const balance = result.metrics.find((metric) => metric.id === "openrouter.account-credits");
    assert.equal(balance?.remaining, undefined);
    assert.equal(balance?.limit, 100);
    assert.deepEqual(balance?.breakdown, [{ label: "purchased", value: 100 }]);
    assert.match(result.notice ?? "", /total_usage/);
  });

  it("treats a malformed total_usage as unknown rather than zero", () => {
    const result = openrouterJsonParser.parse({
      now: NOW,
      json: { data: { total_credits: 50, total_usage: "many" } },
    });
    assert.ok(result);
    const balance = result.metrics.find((metric) => metric.id === "openrouter.account-credits");
    assert.equal(balance?.remaining, undefined);
    assert.equal(balance?.used, undefined);
    assert.match(result.notice ?? "", /remaining is unknown/);
  });

  it("does not match arbitrary JSON envelopes", () => {
    assert.equal(openrouterJsonParser.detect({ json: { data: { limits: [] } }, now: NOW }), false);
    assert.equal(openrouterJsonParser.detect({ json: { data: { usage: 1 } }, now: NOW }), false);
  });
});
