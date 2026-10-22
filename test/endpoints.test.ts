import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTarget } from "../src/auth.ts";
import { normalizeConfig, type ProviderConfig } from "../src/config.ts";
import { FIRST_PARTY_HINTS, joinEndpoint, planEndpoints } from "../src/endpoints.ts";
import { UsageUrlError, parseSafeUrl } from "../src/http.ts";
import { fakeModel, fakeRegistry } from "./helpers.ts";

async function targetFor(options: {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  isOAuth?: boolean;
  api?: string;
}) {
  const model = fakeModel({
    provider: options.provider,
    id: "test-model",
    baseUrl: options.baseUrl,
    api: options.api ?? "openai-responses",
  });
  const registry = fakeRegistry(
    {
      apiKey: options.apiKey ?? "test-key",
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      isOAuth: options.isOAuth === true,
    },
    [model],
  );
  const resolution = await resolveTarget(registry, model, { allowInsecureHttp: true });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) throw new Error("unreachable");
  return resolution.target;
}

function plan(target: Awaited<ReturnType<typeof targetFor>>, options: { path?: string; pathMode?: "base" | "origin"; scheme?: string; max?: number } = {}) {
  const config = normalizeConfig({ ...(options.max !== undefined ? { maxDiscoveryRequests: options.max } : {}) });
  const provider: ProviderConfig | undefined =
    options.path !== undefined
      ? {
          path: options.path,
          ...(options.pathMode !== undefined ? { pathMode: options.pathMode } : {}),
          ...(options.scheme !== undefined ? { scheme: options.scheme as ProviderConfig["scheme"] } : {}),
        }
      : undefined;
  return planEndpoints(target, provider, config);
}

describe("endpoints", () => {
  it("uses the deepseek first-party hint on its official origin", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.discovery, false);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0]?.url.href, "https://api.deepseek.com/user/balance");
    assert.deepEqual(result.requests[0]?.allowedOrigins, ["https://api.deepseek.com"]);
    assert.equal(result.requests[0]?.headers.authorization, "Bearer test-key");
    assert.equal(result.requests[0]?.scheme, "deepseek-balance");
  });

  it("discovers same-origin endpoints for a custom proxy and never leaves its origin", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://proxy.example.com/v1" });
    const result = plan(target, { max: 6 });
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.discovery, true);
    const urls = result.requests.map((request) => request.url.href);
    assert.equal(urls[0], "https://proxy.example.com/v1/user/balance");
    assert.ok(urls.includes("https://proxy.example.com/user/balance"));
    for (const request of result.requests) {
      assert.deepEqual(request.allowedOrigins, ["https://proxy.example.com"]);
    }
  });

  it("finds the Codex status alias on a CPA proxy at the origin root", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1", apiKey: "cpa-key" });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.discovery, true);
    const urls = result.requests.map((request) => request.url.href);
    assert.equal(urls[0], "http://localhost:8317/v1/wham/usage");
    assert.ok(urls.includes("http://localhost:8317/backend-api/wham/usage"));
    assert.ok(urls.includes("http://localhost:8317/api/codex/usage"));
  });

  it("does not send native openai OAuth to the legacy ChatGPT WHAM host", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://api.openai.com/v1", isOAuth: true });
    const result = plan(target);
    assert.equal(result.kind, "none");
    if (result.kind !== "none") return;
    assert.equal(result.status, "unsupported");
    assert.match(result.notice, /API-audience token/);
    assert.match(result.notice, /Passive rate-limit headers/);
  });

  it("reports the official openai API-key origin as unsupported without a request", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://api.openai.com/v1", isOAuth: false });
    const result = plan(target);
    assert.equal(result.kind, "none");
    if (result.kind !== "none") return;
    assert.equal(result.status, "unsupported");
  });

  it("keeps the legacy openai-codex mapping on its ChatGPT origin", async () => {
    const accountId = "acct_123";
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
    const target = await targetFor({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: `header.${claims}.signature`,
      headers: { "X-Custom-Routing": "local" },
      isOAuth: true,
    });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    const request = result.requests[0];
    assert.equal(request?.url.href, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(new Headers(request?.headers).get("authorization"), "Bearer header." + claims + ".signature");
    assert.equal(new Headers(request?.headers).get("chatgpt-account-id"), accountId);
  });

  it("discovers only within a custom openai endpoint", async () => {
    const target = await targetFor({ provider: "openai", baseUrl: "https://gateway.example.com/v1", isOAuth: true });
    const result = plan(target, { max: 3 });
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests.length, 3);
    for (const request of result.requests) {
      assert.equal(request.url.origin, "https://gateway.example.com");
    }
  });

  it("requires OAuth for the Anthropic subscription endpoint and sends its protocol headers", async () => {
    const apiKeyTarget = await targetFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-api03-x", api: "anthropic-messages" });
    const refused = plan(apiKeyTarget);
    assert.equal(refused.kind, "none");

    const oauthTarget = await targetFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-oat-x", isOAuth: true, api: "anthropic-messages" });
    const result = plan(oauthTarget);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests[0]?.url.href, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(result.requests[0]?.headers["anthropic-version"], "2023-06-01");
    assert.equal(result.requests[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(result.requests[0]?.headers.authorization, "Bearer sk-ant-oat-x");
    assert.equal(result.requests[0]?.headers["x-api-key"], undefined);
  });

  it("uses x-api-key for Anthropic API-key credentials on a custom origin", async () => {
    const target = await targetFor({ provider: "anthropic", baseUrl: "https://claude-proxy.example.com", apiKey: "sk-ant-api03-x", api: "anthropic-messages" });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests[0]?.headers["x-api-key"], "sk-ant-api03-x");
    assert.equal(result.requests[0]?.headers.authorization, undefined);
  });

  it("sends the raw Z.ai key without a Bearer prefix on its official origin", async () => {
    const target = await targetFor({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "zai-raw-key" });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests[0]?.url.href, "https://api.z.ai/api/monitor/usage/quota/limit");
    assert.equal(result.requests[0]?.headers.authorization, "zai-raw-key");
  });

  it("replaces an existing authorization spelling when normalizing the Z.ai key", async () => {
    const target = await targetFor({
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "zai-raw-key",
      headers: { Authorization: "Bearer zai-raw-key" },
    });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(new Headers(result.requests[0]?.headers).get("authorization"), "zai-raw-key");
  });

  it("normalizes the effective Z.ai authorization credential instead of substituting the API key", async () => {
    const target = await targetFor({
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "key-A",
      headers: { Authorization: "Bearer key-B" },
    });
    const automatic = plan(target);
    const pinned = plan(target, { path: "/api/monitor/usage/quota/limit", pathMode: "origin" });
    assert.equal(automatic.kind, "requests");
    assert.equal(pinned.kind, "requests");
    if (automatic.kind !== "requests" || pinned.kind !== "requests") return;
    assert.equal(new Headers(automatic.requests[0]?.headers).get("authorization"), "key-B");
    assert.equal(new Headers(pinned.requests[0]?.headers).get("authorization"), "key-B");
  });

  it("reports an unnormalizable effective Z.ai authorization form as unsupported", async () => {
    const unrelatedScheme = await targetFor({
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "key-A",
      headers: { Authorization: "Basic key-B" },
    });
    for (const result of [plan(unrelatedScheme), plan(unrelatedScheme, { path: "/api/monitor/usage/quota/limit", pathMode: "origin" })]) {
      assert.equal(result.kind, "none");
      if (result.kind !== "none") return;
      assert.equal(result.status, "unsupported");
      assert.match(result.notice, /raw Authorization credential/);
      assert.equal(result.notice.includes("key-A"), false);
      assert.equal(result.notice.includes("key-B"), false);
    }
  });

  it("normalizes Z.ai from the transport bearer even when an auxiliary auth header exists", async () => {
    const target = await targetFor({
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "key-A",
      headers: { "x-api-key": "key-B" },
    });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(new Headers(result.requests[0]?.headers).get("authorization"), "key-A");
    assert.equal(new Headers(result.requests[0]?.headers).get("x-api-key"), "key-B");
  });

  it("replaces protocol headers case-insensitively", async () => {
    const target = await targetFor({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-oat-x",
      isOAuth: true,
      api: "anthropic-messages",
      headers: { "Anthropic-Version": "old", "anthropic-beta": "old" },
    });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    const headers = new Headers(result.requests[0]?.headers);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  });

  it("does not rewrite auth headers for a custom Z.ai-like origin", async () => {
    const target = await targetFor({ provider: "zai", baseUrl: "https://zai-proxy.example.com/v1", apiKey: "zai-raw-key" });
    const result = plan(target);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests[0]?.url.origin, "https://zai-proxy.example.com");
    assert.equal(result.requests[0]?.headers.authorization, "Bearer zai-raw-key");
  });

  it("keeps the Z.ai raw-key and Anthropic OAuth headers when their endpoints are pinned", async () => {
    const zai = await targetFor({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "zai-raw-key" });
    const automaticZai = plan(zai);
    const pinnedZai = plan(zai, { path: "/api/monitor/usage/quota/limit", pathMode: "origin" });
    assert.equal(automaticZai.kind, "requests");
    assert.equal(pinnedZai.kind, "requests");
    if (automaticZai.kind !== "requests" || pinnedZai.kind !== "requests") return;
    assert.equal(pinnedZai.requests[0]?.url.href, automaticZai.requests[0]?.url.href);
    assert.equal(pinnedZai.requests[0]?.headers.authorization, "zai-raw-key");

    const anthropic = await targetFor({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-oat-x",
      isOAuth: true,
      api: "anthropic-messages",
    });
    const automaticAnthropic = plan(anthropic);
    const pinnedAnthropic = plan(anthropic, { path: "/api/oauth/usage", pathMode: "origin" });
    assert.equal(automaticAnthropic.kind, "requests");
    assert.equal(pinnedAnthropic.kind, "requests");
    if (automaticAnthropic.kind !== "requests" || pinnedAnthropic.kind !== "requests") return;
    assert.equal(pinnedAnthropic.requests[0]?.url.href, automaticAnthropic.requests[0]?.url.href);
    assert.equal(pinnedAnthropic.requests[0]?.headers["anthropic-version"], "2023-06-01");
    assert.equal(pinnedAnthropic.requests[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(pinnedAnthropic.requests[0]?.headers.authorization, "Bearer sk-ant-oat-x");
  });

  it("keeps ChatGPT account attribution when the Codex usage path is pinned but not for an arbitrary path", async () => {
    const accountId = "acct_123";
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
    const codex = await targetFor({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: `header.${claims}.signature`,
      isOAuth: true,
    });
    const pinned = plan(codex, { path: "/wham/usage", pathMode: "base" });
    assert.equal(pinned.kind, "requests");
    if (pinned.kind !== "requests") return;
    assert.equal(new Headers(pinned.requests[0]?.headers).get("chatgpt-account-id"), accountId);

    const zai = await targetFor({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "zai-raw-key" });
    const arbitrary = plan(zai, { path: "/custom/usage", pathMode: "origin" });
    assert.equal(arbitrary.kind, "requests");
    if (arbitrary.kind !== "requests") return;
    assert.equal(arbitrary.requests[0]?.headers.authorization, "Bearer zai-raw-key");
  });

  it("preserves explicit ChatGPT account routing over account attribution from the token", async () => {
    const tokenAccount = "acct_token";
    const explicitAccount = "account-B";
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: tokenAccount } }),
    ).toString("base64url");
    const codex = await targetFor({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: `header.${claims}.signature`,
      headers: { "ChatGPT-Account-Id": explicitAccount },
      isOAuth: true,
    });
    const automatic = plan(codex);
    const pinned = plan(codex, { path: "/wham/usage", pathMode: "base" });
    assert.equal(automatic.kind, "requests");
    assert.equal(pinned.kind, "requests");
    if (automatic.kind !== "requests" || pinned.kind !== "requests") return;
    assert.equal(new Headers(automatic.requests[0]?.headers).get("chatgpt-account-id"), explicitAccount);
    assert.equal(new Headers(pinned.requests[0]?.headers).get("chatgpt-account-id"), explicitAccount);
  });

  it("keeps a null-suppressed ChatGPT account header suppressed on automatic and pinned endpoints", async () => {
    const tokenAccount = "acct_token";
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: tokenAccount } }),
    ).toString("base64url");
    const codex = await targetFor({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: `header.${claims}.signature`,
      headers: { "cHaTgPt-AcCoUnT-Id": null },
      isOAuth: true,
    });
    for (const result of [plan(codex), plan(codex, { path: "/wham/usage", pathMode: "base" })]) {
      assert.equal(result.kind, "requests");
      if (result.kind !== "requests") return;
      assert.equal(new Headers(result.requests[0]?.headers).get("chatgpt-account-id"), null);
    }
  });

  it("derives account attribution from the effective token rather than a separate API key", async () => {
    const effectiveAccount = "acct_effective";
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: effectiveAccount } }),
    ).toString("base64url");
    const codex = await targetFor({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: "separate-key",
      headers: { Authorization: `Bearer header.${claims}.signature` },
      isOAuth: true,
    });
    const result = plan(codex);
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(new Headers(result.requests[0]?.headers).get("chatgpt-account-id"), effectiveAccount);
  });

  it("does not transmit a suppressed credential even with custom routing headers", async () => {
    const target = await targetFor({
      provider: "mystery-proxy",
      baseUrl: "https://proxy.example.com/v1",
      apiKey: "credential",
      headers: { Authorization: null, "X-Custom-Auth": "routing-auth" },
    });
    const result = plan(target, { path: "/wham/usage", pathMode: "base" });
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    const headers = new Headers(result.requests[0]?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-custom-auth"), "routing-auth");

    // A first-party endpoint that normally requires the raw credential must
    // also respect an explicit suppression.
    const zai = await targetFor({
      provider: "zai",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "zai-raw-key",
      headers: { authorization: null },
    });
    const zaiPlan = plan(zai);
    assert.equal(zaiPlan.kind, "requests");
    if (zaiPlan.kind !== "requests") return;
    assert.equal(new Headers(zaiPlan.requests[0]?.headers).get("authorization"), null);
  });

  it("honors an explicit path and path mode", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const base = plan(target, { path: "/wham/usage", pathMode: "base" });
    const origin = plan(target, { path: "/wham/usage", pathMode: "origin" });
    assert.equal(base.kind, "requests");
    assert.equal(origin.kind, "requests");
    if (base.kind !== "requests" || origin.kind !== "requests") return;
    assert.equal(base.requests[0]?.url.href, "http://localhost:8317/v1/wham/usage");
    assert.equal(origin.requests[0]?.url.href, "http://localhost:8317/wham/usage");
    assert.equal(base.discovery, false);
  });

  it("applies an explicit scheme and rejects a headers-only scheme for a path", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const explicit = plan(target, { path: "/backend-api/wham/usage", pathMode: "origin", scheme: "codex-json" });
    assert.equal(explicit.kind, "requests");
    if (explicit.kind === "requests") {
      assert.equal(explicit.requests[0]?.scheme, "codex-json");
      assert.equal(explicit.requests[0]?.strictScheme, true);
    }

    const headersOnly = plan(target, { path: "/anything", scheme: "codex-headers" });
    assert.equal(headersOnly.kind, "none");
  });

  it("treats a headers-only override without a path as non-requestable", async () => {
    const target = await targetFor({ provider: "cpa", baseUrl: "http://localhost:8317/v1" });
    const result = planEndpoints(target, { scheme: "rate-limit-headers" }, normalizeConfig({}));
    assert.equal(result.kind, "none");
    if (result.kind !== "none") return;
    assert.equal(result.status, "unsupported");
    assert.match(result.notice, /response headers/);
  });

  it("deduplicates identical candidate URLs and respects the discovery cap", async () => {
    const target = await targetFor({ provider: "mystery", baseUrl: "https://api.example.com/" });
    const result = plan(target, { max: 2 });
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests.length, 2);
    const urls = result.requests.map((request) => request.url.href);
    assert.equal(new Set(urls).size, urls.length);
    assert.equal(urls[0], "https://api.example.com/wham/usage");
  });

  it("keeps every first-party hint bound to its exact official origin", () => {
    for (const hint of FIRST_PARTY_HINTS) {
      for (const origin of hint.officialOrigins) {
        const url = new URL(origin);
        assert.equal(url.protocol, "https:");
        assert.equal(url.pathname, "/");
      }
    }
  });

  it("turns a malformed configured path into a diagnostic instead of throwing", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://api.deepseek.com" });
    const result = plan(target, { path: "//%", pathMode: "origin" });
    assert.equal(result.kind, "none");
    if (result.kind !== "none") return;
    assert.equal(result.status, "unsupported");
    assert.match(result.notice, /could not be resolved to a valid URL/);
  });

  it("keeps a normal configured path on the credential origin", async () => {
    const target = await targetFor({ provider: "deepseek", baseUrl: "https://proxy.example.com/v1" });
    const result = plan(target, { path: "/user/balance", pathMode: "origin" });
    assert.equal(result.kind, "requests");
    if (result.kind !== "requests") return;
    assert.equal(result.requests[0]?.url.href, "https://proxy.example.com/user/balance");
    assert.deepEqual(result.requests[0]?.allowedOrigins, ["https://proxy.example.com"]);
  });
});

describe("joinEndpoint", () => {
  it("preserves the base-path prefix or replaces it with the origin root", () => {
    const base = new URL("https://proxy.example.com/v1");
    assert.equal(joinEndpoint(base, "/wham/usage", "base").href, "https://proxy.example.com/v1/wham/usage");
    assert.equal(joinEndpoint(base, "/wham/usage", "origin").href, "https://proxy.example.com/wham/usage");
    assert.equal(joinEndpoint(new URL("https://api.example.com"), "/user/balance", "base").href, "https://api.example.com/user/balance");
  });
});

describe("parseSafeUrl", () => {
  it("rejects userinfo, unsupported protocols, and plain HTTP to a remote host", () => {
    assert.throws(() => parseSafeUrl("https://user:pass@api.example.com"), UsageUrlError);
    assert.throws(() => parseSafeUrl("ftp://api.example.com"), UsageUrlError);
    assert.throws(() => parseSafeUrl("http://api.example.com"), UsageUrlError);
    assert.equal(parseSafeUrl("http://localhost:8317/v1").origin, "http://localhost:8317");
    assert.equal(parseSafeUrl("http://api.example.com", { allowInsecureHttp: true }).origin, "http://api.example.com");
  });
});
