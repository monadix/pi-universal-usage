import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSchemeId, parseHeaderPayload, parseJsonPayload, SCHEME_IDS, schemeIsHeadersOnly } from "../src/registry.ts";

const NOW = 1_768_000_000_000;

describe("parser registry", () => {
  it("exposes one entry per advertised scheme", () => {
    assert.deepEqual([...SCHEME_IDS].sort(), [
      "anthropic-headers",
      "anthropic-json",
      "codex-headers",
      "codex-json",
      "deepseek-balance",
      "kimi-json",
      "opencode-go-json",
      "openrouter-json",
      "rate-limit-headers",
      "zai-json",
    ]);
    assert.equal(isSchemeId("codex-json"), true);
    assert.equal(isSchemeId("nope"), false);
    assert.equal(schemeIsHeadersOnly("codex-headers"), true);
    assert.equal(schemeIsHeadersOnly("codex-json"), false);
  });

  it("auto-detects the payload shape and never guesses from the provider", () => {
    const codex = parseJsonPayload({ now: NOW, json: { rate_limit: { primary_window: { used_percent: 1 } } } });
    assert.equal(codex?.scheme, "codex-json");
    const deepseek = parseJsonPayload({ now: NOW, json: { balance_infos: [{ currency: "USD", total_balance: "1" }] } });
    assert.equal(deepseek?.scheme, "deepseek-balance");
    const opencodeGo = parseJsonPayload({ now: NOW, json: { usage: { rolling: { percent: 0, status: "ok" } } } });
    assert.equal(opencodeGo?.scheme, "opencode-go-json");
    assert.equal(parseJsonPayload({ now: NOW, json: { hello: "world" } }), undefined);
  });

  it("honors an explicit scheme for a JSON body", () => {
    // A body with both shapes must be read with the requested scheme only.
    const json = {
      rate_limit: { primary_window: { used_percent: 9 } },
      balance_infos: [{ currency: "USD", total_balance: "2" }],
    };
    const asCodex = parseJsonPayload({ now: NOW, json }, "codex-json");
    assert.deepEqual(asCodex?.metrics.map((metric) => metric.id), ["codex.primary"]);
    const asDeepseek = parseJsonPayload({ now: NOW, json }, "deepseek-balance");
    assert.deepEqual(asDeepseek?.metrics.map((metric) => metric.id), ["deepseek.balance.usd"]);
    assert.equal(parseJsonPayload({ now: NOW, json }, "kimi-json"), undefined);
  });

  it("merges independent header dimensions that coexist on one response", () => {
    const results = parseHeaderPayload(
      {
        "x-codex-secondary-used-percent": "40",
        "x-codex-secondary-window-minutes": "10080",
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "x-ratelimit-limit-requests": "10",
        "x-ratelimit-remaining-requests": "5",
      },
      200,
      NOW,
    );
    assert.deepEqual(results.map((result) => result.scheme).sort(), ["anthropic-headers", "codex-headers", "rate-limit-headers"]);
    const ids = results.flatMap((result) => result.metrics.map((metric) => metric.id));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("keeps an explicit rejection even when it has no window metrics", () => {
    const results = parseHeaderPayload({ "anthropic-ratelimit-unified-status": "rejected" }, 429, NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.scheme, "anthropic-headers");
    assert.equal(results[0]?.rateLimited, true);
    assert.deepEqual(results[0]?.metrics, []);
  });

  it("returns nothing for a response with no quota headers", () => {
    assert.deepEqual(parseHeaderPayload({ "content-type": "application/json", "retry-after": "5" }, 200, NOW), []);
  });
});
