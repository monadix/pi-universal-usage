import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_HTTP_POLICY, httpGet } from "../src/http.ts";
import { sequenceFetch, textResponse } from "./helpers.ts";

const policy = { ...DEFAULT_HTTP_POLICY, timeoutMs: 100 };

describe("httpGet", () => {
  it("returns status, headers, and a bounded body", async () => {
    const { fetchImpl, calls } = sequenceFetch([textResponse("{\"ok\":true}", { headers: { "x-test": "1" } })]);
    const outcome = await httpGet(new URL("https://api.example.com/key"), { headers: { authorization: "Bearer x" }, allowedOrigins: ["https://api.example.com"] }, policy, undefined, fetchImpl);
    assert.equal(outcome.kind, "response");
    if (outcome.kind !== "response") return;
    assert.equal(outcome.status, 200);
    assert.equal(outcome.headers["x-test"], "1");
    assert.equal(outcome.body, "{\"ok\":true}");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.authorization, "Bearer x");
  });

  it("refuses to send credentials to an origin outside the allowlist", async () => {
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const outcome = await httpGet(new URL("https://evil.example.com/key"), { headers: { authorization: "Bearer x" }, allowedOrigins: ["https://api.example.com"] }, policy, undefined, fetchImpl);
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "origin");
    assert.equal(calls.length, 0);
    assert.equal(outcome.message.includes("evil.example.com"), false);
  });

  it("rejects a redirect instead of following it", async () => {
    const { fetchImpl } = sequenceFetch([new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } })]);
    const outcome = await httpGet(new URL("https://api.example.com/key"), { headers: {}, allowedOrigins: ["https://api.example.com"] }, policy, undefined, fetchImpl);
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "redirect");
    assert.match(outcome.message, /redirect/i);
  });

  it("cancels a redirect response body instead of leaving it open", async () => {
    let bodyCancelled = false;
    let calls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("redirecting"));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(stream, { status: 302, headers: { location: "https://elsewhere.example.com" } });
    }) as typeof fetch;
    const outcome = await httpGet(
      new URL("https://api.example.com/key"),
      { headers: { authorization: "Bearer x" }, allowedOrigins: ["https://api.example.com"] },
      policy,
      undefined,
      fetchImpl,
    );
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "redirect");
    assert.equal(bodyCancelled, true);
    assert.equal(calls, 1);
  });

  it("times out a hanging request", async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const outcome = await httpGet(new URL("https://api.example.com/key"), { headers: {}, allowedOrigins: ["https://api.example.com"] }, { ...policy, timeoutMs: 10 }, undefined, fetchImpl);
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "timeout");
  });

  it("honors a parent abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = sequenceFetch([textResponse("")]);
    const outcome = await httpGet(new URL("https://api.example.com/key"), { headers: {}, allowedOrigins: ["https://api.example.com"] }, policy, controller.signal, fetchImpl);
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "aborted");
    assert.equal(calls.length, 0);
  });

  it("stops reading a body above the size limit", async () => {
    const { fetchImpl } = sequenceFetch([textResponse("x".repeat(5000))]);
    const outcome = await httpGet(new URL("https://api.example.com/key"), { headers: {}, allowedOrigins: ["https://api.example.com"] }, { ...policy, maxBodyBytes: 100 }, undefined, fetchImpl);
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "body-too-large");
  });

  it("reports a network failure as a fixed public error", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused SENTINEL-NETWORK");
    }) as unknown as typeof fetch;
    const outcome = await httpGet(new URL("https://api.example.com/key"), { headers: {}, allowedOrigins: ["https://api.example.com"] }, policy, undefined, fetchImpl);
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "network");
    assert.equal(outcome.message, "network request failed");
    assert.equal(outcome.message.includes("SENTINEL"), false);
  });

  it("redacts a request-header construction failure before it reaches a report", async () => {
    const sentinel = "SENTINEL\nheader-value";
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      // Undici validates header values during Request construction and embeds
      // the rejected value in the thrown TypeError.
      new Headers(init?.headers as Record<string, string>);
      throw new Error("unreachable");
    }) as typeof fetch;
    const outcome = await httpGet(
      new URL("https://api.example.com/key"),
      { headers: { authorization: sentinel }, allowedOrigins: ["https://api.example.com"] },
      policy,
      undefined,
      fetchImpl,
    );
    assert.equal(outcome.kind, "error");
    if (outcome.kind !== "error") return;
    assert.equal(outcome.reason, "network");
    assert.equal(outcome.message, "network request failed");
    assert.equal(outcome.message.includes("SENTINEL"), false);
  });
});
