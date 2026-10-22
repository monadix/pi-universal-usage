import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainText } from "../src/text.ts";

describe("plainText", () => {
  it("removes CSI, OSC, C1, and control sequences while keeping ordinary text", () => {
    const value = "plan=pro\u001b[31m\u001b]52;c;SGVsbG8=\u0007\u009b2J\u0000line\nnext\tcell";
    const sanitized = plainText(value);
    assert.equal(sanitized, "plan=prolinenextcell");
    for (const character of ["\u001b", "\u0007", "\u0000", "\u009b", "\n", "\t"]) {
      assert.equal(sanitized.includes(character), false);
    }
    assert.match(sanitized, /plan=pro/);
    assert.match(sanitized, /line/);
    assert.match(sanitized, /next/);
  });

  it("removes bidi control characters without changing ordinary unicode text", () => {
    assert.equal(plainText("cpa \u202e42%\u202c · 使用量"), "cpa 42% · 使用量");
  });
});
