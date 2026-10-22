import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deepseekBalanceParser } from "../src/parsers/deepseek.ts";

const NOW = 1_768_000_000_000;

describe("deepseek-balance", () => {
  it("keeps each currency as its own balance with a breakdown", () => {
    const result = deepseekBalanceParser.parse({
      now: NOW,
      json: {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
          { currency: "USD", total_balance: "3.25", granted_balance: "0.00", topped_up_balance: "3.25" },
        ],
      },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 2);
    assert.equal(result.metrics[0]?.label, "balance (CNY)");
    assert.equal(result.metrics[0]?.remaining, 110);
    assert.equal(result.metrics[0]?.unit, "CNY");
    assert.deepEqual(result.metrics[0]?.breakdown, [
      { label: "granted", value: 10 },
      { label: "topped up", value: 100 },
    ]);
    assert.equal(result.metrics[1]?.remaining, 3.25);
  });

  it("keeps zero and negative amounts unchanged", () => {
    const result = deepseekBalanceParser.parse({
      now: NOW,
      json: {
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "0", granted_balance: "0", topped_up_balance: "0" },
          { currency: "CNY", total_balance: "-1.50", granted_balance: "0", topped_up_balance: "-1.50" },
        ],
      },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.remaining, 0);
    assert.equal(result.metrics[1]?.remaining, -1.5);
  });

  it("reports an unavailable balance as status without fabricating amounts", () => {
    const result = deepseekBalanceParser.parse({ now: NOW, json: { is_available: false, balance_infos: [] } });
    assert.ok(result);
    assert.equal(result.metrics.length, 1);
    assert.equal(result.metrics[0]?.status, "unavailable");
  });

  it("skips an entry without a currency and says so", () => {
    const result = deepseekBalanceParser.parse({
      now: NOW,
      json: { balance_infos: [{ total_balance: "5" }, { currency: "USD", total_balance: "1" }] },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 1);
    assert.match(result.notice ?? "", /no usable currency\/total_balance/);
  });

  it("does not match unrelated JSON", () => {
    assert.equal(deepseekBalanceParser.detect({ json: { is_available: "yes" }, now: NOW }), false);
    assert.equal(deepseekBalanceParser.detect({ json: { rate_limit: {} }, now: NOW }), false);
  });
});
