import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rateLimitHeadersParser } from "../src/parsers/rate-limit-headers.ts";

const NOW = 1_768_000_000_000;

describe("rate-limit-headers", () => {
  it("parses OpenAI request and token budgets with duration resets", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "40",
        "x-ratelimit-reset-requests": "6m0s",
        "x-ratelimit-limit-tokens": "200000",
        "x-ratelimit-remaining-tokens": "50000",
        "x-ratelimit-reset-tokens": "1s",
      },
    });
    assert.ok(result);
    assert.equal(result.metrics.length, 2);
    const [requests, tokens] = result.metrics;
    assert.equal(requests?.kind, "request-limit");
    assert.equal(requests?.usedPercent, 60);
    assert.equal(requests?.resetAtSeconds, Math.round(NOW / 1000 + 360));
    assert.equal(tokens?.kind, "token-limit");
    assert.equal(tokens?.usedPercent, 75);
    assert.equal(tokens?.resetAtSeconds, Math.round(NOW / 1000 + 1));
  });

  it("parses the IETF RateLimit-* form and its policy window", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: {
        "RateLimit-Limit": "100",
        "RateLimit-Remaining": "90",
        "RateLimit-Reset": "30",
        "RateLimit-Policy": "100;w=60",
      },
    });
    assert.ok(result);
    const metric = result.metrics[0];
    assert.equal(metric?.id, "ratelimit.policy");
    assert.equal(metric?.limit, 100);
    assert.equal(metric?.remaining, 90);
    assert.equal(metric?.usedPercent, 10);
    assert.equal(metric?.durationSeconds, 60);
    assert.equal(metric?.resetAtSeconds, Math.round(NOW / 1000 + 30));
  });

  it("keeps a limit without a remaining value rather than inventing a percent", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "x-ratelimit-limit-requests": "500", "x-ratelimit-reset-requests": "1m" },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.usedPercent, undefined);
    assert.equal(result.metrics[0]?.limit, 500);
  });

  it("parses the bare x-ratelimit family with an absolute epoch reset", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "75",
        "x-ratelimit-reset": "1768003600",
      },
    });
    assert.ok(result);
    const metric = result.metrics[0];
    assert.equal(metric?.id, "ratelimit.bare");
    assert.equal(metric?.limit, 100);
    assert.equal(metric?.remaining, 75);
    assert.equal(metric?.usedPercent, 25);
    assert.equal(metric?.resetAtSeconds, 1768003600);
  });

  it("does not reinterpret a non-epoch bare reset as a duration", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "5", "x-ratelimit-reset": "30" },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.resetAtSeconds, undefined);
    assert.match(result.notice ?? "", /not an absolute Unix timestamp/);
  });

  it("prefers the suffixed request/token dimensions over the bare family", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "75",
        "x-ratelimit-limit-requests": "10",
        "x-ratelimit-remaining-requests": "5",
      },
    });
    assert.ok(result);
    assert.deepEqual(result.metrics.map((metric) => metric.id), ["ratelimit.requests"]);
  });

  it("drops negative or non-finite counts", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "x-ratelimit-limit": "-5", "x-ratelimit-remaining": "Infinity" },
    });
    assert.equal(result, undefined);
  });

  it("drops a duration reset whose unit conversion overflows", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "x-ratelimit-limit-requests": "10", "x-ratelimit-reset-requests": `${"9".repeat(307)}d` },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.limit, 10);
    assert.equal(result.metrics[0]?.resetAtSeconds, undefined);
  });

  it("drops a policy window whose number is not finite", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "RateLimit-Limit": "100", "RateLimit-Policy": `100;w=${"9".repeat(309)}` },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.limit, 100);
    assert.equal(result.metrics[0]?.durationSeconds, undefined);
  });

  it("never turns Retry-After into a quota dimension", () => {
    assert.equal(rateLimitHeadersParser.detect({ headers: { "retry-after": "30" }, now: NOW }), false);
    assert.equal(rateLimitHeadersParser.parse({ now: NOW, headers: { "retry-after": "30" } }), undefined);
  });

  it("drops a malformed duration reset and keeps the numeric limits", () => {
    const result = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "x-ratelimit-remaining-tokens": "10", "x-ratelimit-reset-tokens": "soon" },
    });
    assert.ok(result);
    assert.equal(result.metrics[0]?.remaining, 10);
    assert.equal(result.metrics[0]?.resetAtSeconds, undefined);
  });
});
