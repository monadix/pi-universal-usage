import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeConfig } from "../src/config.ts";
import { formatCompact, formatDuration, formatMetric, formatPercent, formatReport } from "../src/format.ts";
import { anthropicJsonParser } from "../src/parsers/anthropic.ts";
import { codexJsonParser } from "../src/parsers/codex-json.ts";
import { deepseekBalanceParser } from "../src/parsers/deepseek.ts";
import { rateLimitHeadersParser } from "../src/parsers/rate-limit-headers.ts";
import type { TargetSnapshot } from "../src/types.ts";

const NOW = 1_768_000_000_000;
const config = normalizeConfig({ refreshSeconds: 300 });

const identity = {
  key: "deepseek|https://api.deepseek.com|/|environment|key|openai-responses",
  providerId: "deepseek",
  modelId: "deepseek-chat",
  origin: "https://api.deepseek.com",
  basePath: "/",
  authSource: "environment",
  isOAuth: false,
};

function snapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    identity,
    status: "ok",
    scheme: "deepseek-balance",
    endpoint: "https://api.deepseek.com/user/balance",
    metrics: [
      {
        id: "deepseek.balance.usd",
        kind: "balance",
        label: "balance (USD)",
        scope: "account",
        remaining: 7.5,
        unit: "USD",
        source: "deepseek-balance",
      },
    ],
    fetchedAt: NOW,
    source: "http",
    ...overrides,
  };
}

describe("formatting", () => {
  it("clamps displayed percentages without touching stored values", () => {
    assert.equal(formatPercent(42.3), "42.3%");
    assert.match(formatPercent(42.345), /^42\.3/);
    assert.equal(formatPercent(140), "100%");
    assert.equal(formatPercent(-5), "0%");
  });

  it("formats durations and elapsed resets", () => {
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(3900), "1h 5m");
    assert.equal(formatDuration(2 * 86400 + 3600), "2d 1h");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), "unknown");
    const line = formatMetric(
      { id: "x", kind: "subscription-window", label: "5-hour window", usedPercent: 20, resetAtSeconds: Math.round(NOW / 1000) - 60, source: "codex-json" },
      NOW,
    );
    assert.match(line, /reset elapsed/);
  });

  it("keeps an elapsed window visible instead of resetting it to zero", () => {
    const text = formatReport(
      [snapshot({
        metrics: [
          { id: "codex.secondary", kind: "subscription-window", label: "7d window", usedPercent: 88, resetAtSeconds: Math.round(NOW / 1000) - 3600, source: "codex-json" },
        ],
      })],
      config,
      NOW,
    ).join("\n");
    assert.match(text, /88%/);
    assert.match(text, /reset elapsed/);
  });

  it("renders only the endpoint path, never the effective origin or query", () => {
    const text = formatReport(
      [snapshot({ endpoint: "https://private-gateway.example/base/quota?token=SENTINEL#fragment" })],
      config,
      NOW,
    ).join("\n");
    assert.match(text, /via \/base\/quota/);
    assert.equal(text.includes("private-gateway.example"), false);
    assert.equal(text.includes("SENTINEL"), false);
    assert.equal(text.includes("fragment"), false);
  });

  it("marks a stale snapshot and shows the next attempt", () => {
    const text = formatReport([snapshot({ fetchedAt: NOW - 900_000 })], config, NOW).join("\n");
    assert.match(text, /stale/);
    const retry = formatReport([snapshot({ nextRetryAt: NOW + 60_000, status: "rate-limited", error: "the provider reported a rate limit" })], config, NOW).join("\n");
    assert.match(retry, /next attempt: in 1m/);
    assert.match(retry, /error: the provider reported a rate limit/);
  });

  it("renders rejected and limit-reached window states next to their percentages", () => {
    const rejected = codexJsonParser.parse({
      now: NOW,
      json: { rate_limit: { allowed: false, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } } },
    });
    assert.ok(rejected);
    const rejectedReport = formatReport([snapshot({ metrics: rejected.metrics })], config, NOW).join("\n");
    assert.match(rejectedReport, /20%/);
    assert.match(rejectedReport, /rejected/);
    const rejectedFooter = formatCompact(snapshot({ metrics: rejected.metrics }), NOW, config);
    assert.match(rejectedFooter, /weekly 20% rejected/);

    const limitReached = codexJsonParser.parse({
      now: NOW,
      json: { rate_limit: { limit_reached: true, allowed: false, secondary_window: { used_percent: 100 } } },
    });
    assert.ok(limitReached);
    const limitReport = formatReport([snapshot({ metrics: limitReached.metrics })], config, NOW).join("\n");
    assert.match(limitReport, /100%/);
    assert.match(limitReport, /limit-reached/);
    // No declared duration: the neutral role name, not an invented week.
    assert.match(formatCompact(snapshot({ metrics: limitReached.metrics }), NOW, config), /secondary 100% limit-reached/);
  });

  it("renders a compact footer with provider, short labels, and reset", () => {
    const text = formatCompact(
      snapshot({
        identity: { ...identity, providerId: "cpa" },
        metrics: [
          { id: "codex.secondary", kind: "subscription-window", label: "7d window", usedPercent: 42, durationSeconds: 604800, resetAtSeconds: Math.round(NOW / 1000) + 7200, source: "codex-json" },
          { id: "codex.primary", kind: "subscription-window", label: "5h window", usedPercent: 5, source: "codex-json" },
        ],
      }),
      NOW,
      config,
    );
    assert.match(text, /^cpa: weekly 42%/);
    assert.match(text, /primary 5%/);
    assert.match(text, /reset 2h/);
    assert.doesNotMatch(text, /reset elapsed/);
    assert.doesNotMatch(text, /stale/);
  });

  it("qualifies an elapsed displayed window even when a sibling has a future reset", () => {
    const text = formatCompact(
      snapshot({
        identity: { ...identity, providerId: "cpa" },
        metrics: [
          {
            id: "codex.primary",
            kind: "subscription-window",
            label: "5h window",
            usedPercent: 88,
            resetAtSeconds: Math.round(NOW / 1000) - 60,
            source: "codex-json",
          },
          {
            id: "codex.secondary",
            kind: "subscription-window",
            label: "7d window",
            usedPercent: 42,
            durationSeconds: 604800,
            resetAtSeconds: Math.round(NOW / 1000) + 2 * 86400,
            source: "codex-json",
          },
        ],
      }),
      NOW,
      config,
    );
    assert.match(text, /primary 88% reset elapsed/);
    assert.match(text, /weekly 42%/);
    assert.match(text, /reset 2d/);
  });

  it("shows a limit-only measurement as an explicitly unknown-usage cap", () => {
    const parsed = rateLimitHeadersParser.parse({
      now: NOW,
      headers: { "x-ratelimit-limit-requests": "500", "x-ratelimit-reset-requests": "1m" },
    });
    assert.ok(parsed);
    const metric = parsed.metrics[0];
    assert.ok(metric);
    assert.equal(metric.usedPercent, undefined);

    const line = formatMetric(metric, NOW);
    assert.match(line, /requests limit 500; usage unknown/);
    assert.match(line, /resets in 1m/);
    assert.doesNotMatch(line, /%/);

    const footer = formatCompact(snapshot({ identity: { ...identity, providerId: "openai" }, metrics: parsed.metrics }), NOW, config);
    assert.match(footer, /req limit 500; usage unknown/);
    assert.doesNotMatch(footer, /%/);
  });

  it("labels a Codex secondary window by its declared non-weekly duration", () => {
    const parsed = codexJsonParser.parse({
      now: NOW,
      json: { rate_limit: { secondary_window: { used_percent: 40, limit_window_seconds: 86400 } } },
    });
    assert.ok(parsed);
    assert.equal(parsed.metrics[0]?.label, "1d window");
    const text = formatCompact(snapshot({ identity: { ...identity, providerId: "cpa" }, metrics: parsed.metrics }), NOW, config);
    assert.match(text, /^cpa: 1d 40%/);
    assert.doesNotMatch(text, /weekly/);
  });

  it("does not invent a weekly label for an unstated Codex duration", () => {
    const parsed = codexJsonParser.parse({
      now: NOW,
      json: { rate_limit: { secondary_window: { used_percent: 40 } } },
    });
    assert.ok(parsed);
    const text = formatCompact(snapshot({ identity: { ...identity, providerId: "cpa" }, metrics: parsed.metrics }), NOW, config);
    assert.match(text, /^cpa: secondary 40%/);
    assert.doesNotMatch(text, /weekly/);
  });

  it("summarizes the nearest future reset rather than the first displayed one", () => {
    const text = formatCompact(
      snapshot({
        identity: { ...identity, providerId: "cpa" },
        metrics: [
          {
            id: "codex.secondary",
            kind: "subscription-window",
            label: "7d window",
            usedPercent: 42,
            durationSeconds: 604800,
            resetAtSeconds: Math.round(NOW / 1000) + 5 * 86400,
            source: "codex-json",
          },
          {
            id: "codex.primary",
            kind: "subscription-window",
            label: "5h window",
            usedPercent: 5,
            resetAtSeconds: Math.round(NOW / 1000) + 3600,
            source: "codex-json",
          },
        ],
      }),
      NOW,
      config,
    );
    assert.match(text, /reset 1h/);
    assert.doesNotMatch(text, /reset 5d/);
  });

  it("strips terminal escape and control sequences from remote quota text", () => {
    const escape = "\u001b";
    const osc = `${escape}]52;c;SGVsbG8=\u0007`;
    const csi = `${escape}[31m`;
    const c1 = "\u009b2J";
    const codex = codexJsonParser.parse({
      now: NOW,
      json: {
        plan_type: `pro${osc}`,
        quota_mode: `shadow${csi}`,
        rate_limit: { primary_window: { used_percent: 20 } },
      },
    });
    const deepseek = deepseekBalanceParser.parse({
      now: NOW,
      json: { balance_infos: [{ currency: `USD${csi}${c1}`, total_balance: "1" }] },
    });
    const anthropic = anthropicJsonParser.parse({
      now: NOW,
      json: { [`seven_day_opus${osc}`]: { utilization: 30 } },
    });
    assert.ok(codex && deepseek && anthropic);

    const snapshots = [
      snapshot({ metrics: codex.metrics, ...(codex.notice !== undefined ? { notice: codex.notice } : {}) }),
      snapshot({ metrics: deepseek.metrics }),
      snapshot({ metrics: anthropic.metrics }),
    ];
    const report = formatReport(snapshots, config, NOW).join("\n");
    const footer = formatCompact(snapshots[1] as TargetSnapshot, NOW, config);
    const line = formatMetric(
      { id: "x", kind: "subscription-window", label: `window${osc}`, usedPercent: 1, source: "codex-json" },
      NOW,
    );
    for (const text of [report, footer, line]) {
      for (const character of ["\u001b", "\u0007", "\u009b"]) assert.equal(text.includes(character), false);
    }
    assert.match(report, /plan=pro/);
    assert.match(report, /balance \(USD/);
    assert.match(report, /opus 7-day window/);
    assert.match(footer, /USD/);
  });

  it("marks an elapsed footer reset and a stale snapshot", () => {
    const text = formatCompact(
      snapshot({
        identity: { ...identity, providerId: "cpa" },
        metrics: [
          {
            id: "codex.secondary",
            kind: "subscription-window",
            label: "7d window",
            usedPercent: 88,
            durationSeconds: 604800,
            resetAtSeconds: Math.round(NOW / 1000) - 3600,
            source: "codex-json",
          },
        ],
        fetchedAt: NOW - 900_000,
      }),
      NOW,
      config,
    );
    assert.match(text, /weekly 88%/);
    assert.match(text, /reset elapsed/);
    assert.match(text, /stale/);
  });

  it("does not imply a quota for an unsupported provider", () => {
    const text = formatCompact(snapshot({ status: "unsupported", metrics: [] }), NOW, config);
    assert.equal(text, "deepseek: no quota interface");
  });
});
