import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessLoaderHealth, loaderFailureSummary } from "../scripts/smoke-health.ts";

describe("live smoke loader health", () => {
  it("allows provider validation only when loading and registration are clean", () => {
    assert.deepEqual(assessLoaderHealth([{ type: "info" }, { type: "warning" }], []), {
      ok: true,
      extensionErrors: 0,
      registrationErrors: 0,
    });
    assert.equal(assessLoaderHealth([], [{ path: "/secret", error: "SENTINEL" }]).ok, false);
    assert.equal(assessLoaderHealth([{ type: "error" }], []).ok, false);
  });

  it("summarizes failures with counts only, never raw paths or messages", () => {
    const health = assessLoaderHealth([{ type: "error" }, { type: "error" }, { type: "info" }], [{ path: "/SENTINEL" }]);
    assert.deepEqual(health, { ok: false, extensionErrors: 1, registrationErrors: 2 });
    const summary = loaderFailureSummary(health);
    assert.match(summary, /extensionErrors=1/);
    assert.match(summary, /registrationErrors=2/);
    assert.equal(summary.includes("SENTINEL"), false);
    assert.equal(summary.includes("/"), false);
  });
});
