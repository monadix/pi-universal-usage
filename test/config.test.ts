import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import {
  agentDir,
  CONFIG_FILE_NAME,
  configPath,
  loadConfig,
  MAX_TIMER_DELAY_MS,
  MAX_TIMER_DELAY_SECONDS,
  normalizeConfig,
} from "../src/config.ts";

describe("configuration", () => {
  it("uses PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
    assert.equal(agentDir({}), join(process.env.HOME ?? "", ".pi", "agent"));
    assert.equal(configPath({ PI_CODING_AGENT_DIR: "/custom/agent" }), join("/custom/agent", CONFIG_FILE_NAME));
  });

  it("applies defaults for a missing or empty file", () => {
    const missing = loadConfig({ readFile: () => { throw new Error("ENOENT"); } });
    assert.equal(missing.refreshSeconds, 300);
    assert.equal(missing.autoRefresh, true);
    assert.deepEqual(missing.problems, []);
  });

  it("reports invalid JSON without throwing", () => {
    const config = loadConfig({ readFile: () => "{ not json" });
    assert.match(config.problems.join(" "), /not valid JSON/);
    assert.equal(config.refreshSeconds, 300);
  });

  it("validates provider entries and keeps the valid parts", () => {
    const config = normalizeConfig({
      refreshSeconds: 120,
      minRefreshSeconds: 30,
      timeoutMs: 2000,
      maxDiscoveryRequests: 2,
      autoRefresh: false,
      providers: {
        cpa: { scheme: "codex-json", path: "/backend-api/wham/usage", pathMode: "origin" },
        broken: { scheme: "made-up", path: "https://elsewhere.example.com", pathMode: "sideways" },
        off: { enabled: false },
      },
    });
    assert.equal(config.refreshSeconds, 120);
    assert.equal(config.maxDiscoveryRequests, 2);
    assert.equal(config.autoRefresh, false);
    assert.deepEqual(config.providers.get("cpa"), {
      scheme: "codex-json",
      path: "/backend-api/wham/usage",
      pathMode: "origin",
    });
    assert.equal(config.providers.get("broken")?.scheme, "auto");
    assert.equal(config.providers.get("broken")?.path, undefined);
    assert.match(config.problems.join(" "), /made-up/);
    assert.match(config.problems.join(" "), /path must be an absolute path/);
    assert.equal(config.providers.get("off")?.enabled, false);
  });

  it("clamps unusably small values to the defaults instead of accepting them", () => {
    const config = normalizeConfig({ refreshSeconds: 1, timeoutMs: 10, maxBodyBytes: 2 });
    assert.equal(config.refreshSeconds, 300);
    assert.equal(config.timeoutMs, 8000);
    assert.equal(config.maxBodyBytes, 256 * 1024);
  });

  it("rejects timer settings above the Node timer range", () => {
    const config = normalizeConfig({
      refreshSeconds: 2_592_000,
      minRefreshSeconds: 2_592_000,
      timeoutMs: 3_000_000_000,
    });
    assert.equal(config.refreshSeconds, 300);
    assert.equal(config.minRefreshSeconds, 60);
    assert.equal(config.timeoutMs, 8000);
    assert.match(config.problems.join(" "), /refreshSeconds must be at most/);
    assert.match(config.problems.join(" "), /minRefreshSeconds must be at most/);
    assert.match(config.problems.join(" "), /timeoutMs must be at most/);
  });

  it("accepts timer settings up to the safe boundary without overflowing", () => {
    const config = normalizeConfig({
      refreshSeconds: MAX_TIMER_DELAY_SECONDS,
      minRefreshSeconds: MAX_TIMER_DELAY_SECONDS,
      timeoutMs: MAX_TIMER_DELAY_MS,
    });
    assert.equal(config.refreshSeconds, MAX_TIMER_DELAY_SECONDS);
    assert.equal(config.minRefreshSeconds, MAX_TIMER_DELAY_SECONDS);
    assert.equal(config.timeoutMs, MAX_TIMER_DELAY_MS);
    assert.deepEqual(config.problems, []);
    assert.ok(Math.max(config.refreshSeconds, config.minRefreshSeconds) * 1000 <= MAX_TIMER_DELAY_MS);
    assert.ok(config.timeoutMs <= MAX_TIMER_DELAY_MS);
  });

  it("rejects malformed and network-path configured paths", () => {
    const config = normalizeConfig({
      providers: {
        network: { path: "//%", pathMode: "origin" },
        authority: { path: "//elsewhere.example.com/wham/usage", pathMode: "origin" },
        backslash: { path: "/\\elsewhere.example.com/wham/usage" },
        userinfo: { path: "/a@b.example.com" },
        deepseek: { path: "/user/balance", pathMode: "origin" },
      },
    });
    for (const providerId of ["network", "authority", "backslash", "userinfo"]) {
      assert.equal(config.providers.get(providerId)?.path, undefined, providerId);
      assert.match(config.problems.join(" "), new RegExp(`providers\\.${providerId}\\.path must be an absolute path`));
    }
    assert.equal(config.providers.get("deepseek")?.path, "/user/balance");
    assert.equal(config.providers.get("deepseek")?.pathMode, "origin");
  });

  it("never holds a secret field", () => {
    const config = normalizeConfig({ providers: { cpa: { apiKey: "should-not-be-read", path: "/wham/usage" } } });
    assert.equal(JSON.stringify([...config.providers.entries()]).includes("should-not-be-read"), false);
    assert.deepEqual(config.providers.get("cpa"), { path: "/wham/usage" });
  });
});
