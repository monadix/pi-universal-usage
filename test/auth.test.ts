import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicAuthHeaders,
  AUTH_RESOLUTION_FAILED,
  authorizationCredential,
  chatgptAccountId,
  modelRoutingSignature,
  NO_CREDENTIAL,
  resolveTarget,
} from "../src/auth.ts";
import { fakeModel, fakeRegistry } from "./helpers.ts";

describe("target resolution", () => {
  it("uses the auth-resolved base URL when Pi overrides the model base URL", async () => {
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const registry = fakeRegistry({ apiKey: "k", baseUrl: "https://deepseek-proxy.example.com/v1", source: "stored" }, [model]);
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.baseUrl.origin, "https://deepseek-proxy.example.com");
    assert.equal(resolution.target.identity.basePath, "/v1");
    assert.equal(resolution.target.identity.authSource, "stored");
    assert.equal(resolution.target.originHeaders.authorization, "Bearer k");
  });

  it("preserves configured auth headers while adding the transport default", async () => {
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const registry = fakeRegistry({ apiKey: "ignored", headers: { "x-api-key": "configured", "x-routing": "local" } }, [model]);
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.originHeaders["x-api-key"], "configured");
    assert.equal(resolution.target.originHeaders.authorization, "Bearer ignored");
    assert.equal(resolution.target.originHeaders["x-routing"], "local");
  });

  it("does not let an auxiliary auth header suppress the OpenAI-compatible bearer default", async () => {
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const registry = fakeRegistry({ apiKey: "key-A", headers: { "x-api-key": "key-B" } }, [model]);
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.originHeaders.authorization, "Bearer key-A");
    assert.equal(resolution.target.originHeaders["x-api-key"], "key-B");
  });

  it("does not reconstruct a null-suppressed auth header", async () => {
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const registry = fakeRegistry(
      { apiKey: "k", headers: { Authorization: null, "X-Custom-Auth": "routing-auth" } },
      [model],
    );
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.originHeaders.authorization, undefined);
    assert.equal(resolution.target.originHeaders["X-Custom-Auth"], "routing-auth");
    assert.deepEqual(resolution.target.suppressedHeaders, ["authorization"]);
  });

  it("does not reconstruct an intentionally empty auth header", async () => {
    const model = fakeModel({ provider: "anthropic", id: "chat", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
    const registry = fakeRegistry({ apiKey: "sk-ant-api03-key", headers: { "X-Api-Key": "" } }, [model]);
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.originHeaders["X-Api-Key"], undefined);
    assert.deepEqual(resolution.target.suppressedHeaders, ["x-api-key"]);
  });

  it("keeps a null-suppressed bearer absent while preserving an auxiliary auth header", async () => {
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const registry = fakeRegistry(
      { apiKey: "key-A", headers: { Authorization: null, "x-api-key": "key-B" } },
      [model],
    );
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.originHeaders.authorization, undefined);
    assert.equal(resolution.target.originHeaders["x-api-key"], "key-B");
    assert.deepEqual(resolution.target.suppressedHeaders, ["authorization"]);
  });

  it("reports a missing credential without inventing a target or echoing resolver text", async () => {
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const sentinel = "refresh failed; body=SENTINEL-RETURNED";
    const resolution = await resolveTarget(fakeRegistry({ ok: false, error: sentinel }, [model]), model);
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.equal(resolution.status, "no-credential");
    assert.equal(resolution.error, NO_CREDENTIAL);
    assert.equal(resolution.error.includes(sentinel), false);
  });

  it("replaces thrown auth resolver errors with a fixed public message", async () => {
    const model = fakeModel({ provider: "deepseek", id: "chat", baseUrl: "https://api.deepseek.com" });
    const sentinel = "oauth refresh failed at https://SENTINEL-THROWN?body=secret";
    const resolution = await resolveTarget(fakeRegistry({ throws: sentinel }, [model]), model);
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.equal(resolution.status, "no-credential");
    assert.equal(resolution.error, AUTH_RESOLUTION_FAILED);
    assert.equal(resolution.error.includes("SENTINEL"), false);
  });

  it("separates cache identities when auth or routing headers change", async () => {
    const model = fakeModel({ provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" });
    const headersFor = (routing: string, key: string) => fakeRegistry({ apiKey: key, headers: { "x-routing": routing } }, [model]);
    const first = await resolveTarget(headersFor("a", "key-a"), model);
    const second = await resolveTarget(headersFor("b", "key-a"), model);
    const same = await resolveTarget(headersFor("a", "key-a"), model);
    const rotated = await resolveTarget(headersFor("a", "key-b"), model);
    assert.equal(first.ok && second.ok && same.ok && rotated.ok, true);
    if (!first.ok || !second.ok || !same.ok || !rotated.ok) return;
    assert.notEqual(first.target.identity.key, second.target.identity.key);
    assert.equal(first.target.identity.key, same.target.identity.key);
    assert.notEqual(first.target.identity.key, rotated.target.identity.key);
    // The digest is opaque and never part of the reported identity fields.
    assert.equal(first.target.identity.providerId, "cpa");
    assert.equal(first.target.identity.key.includes("key-a"), false);
  });

  it("separates cache identities when a routing header is null-suppressed", async () => {
    const model = fakeModel({ provider: "openai-codex", id: "chat", baseUrl: "https://chatgpt.com/backend-api" });
    const suppressed = await resolveTarget(
      fakeRegistry({ apiKey: "key-a", headers: { "ChatGPT-Account-Id": null }, isOAuth: true }, [model]),
      model,
    );
    const absent = await resolveTarget(fakeRegistry({ apiKey: "key-a", isOAuth: true }, [model]), model);
    assert.equal(suppressed.ok && absent.ok, true);
    if (!suppressed.ok || !absent.ok) return;
    assert.deepEqual(suppressed.target.suppressedHeaders, ["chatgpt-account-id"]);
    assert.deepEqual(absent.target.suppressedHeaders, []);
    assert.notEqual(suppressed.target.identity.key, absent.target.identity.key);
  });

  it("rejects an unusable base URL protocol", async () => {
    const model = fakeModel({ provider: "custom", id: "chat", baseUrl: "ftp://files.example.com/v1" });
    const resolution = await resolveTarget(fakeRegistry({ apiKey: "k" }, [model]), model);
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.equal(resolution.status, "unsupported");
  });

  it("chooses the Anthropic auth header from the credential kind", () => {
    assert.deepEqual(anthropicAuthHeaders("sk-ant-api03-key"), { "x-api-key": "sk-ant-api03-key" });
    assert.deepEqual(anthropicAuthHeaders("sk-ant-oat-token"), { authorization: "Bearer sk-ant-oat-token" });
  });

  it("extracts the ChatGPT account id only from a token that carries it", () => {
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url");
    assert.equal(chatgptAccountId(`a.${claims}.c`), "acct_9");
    assert.equal(chatgptAccountId("not-a-jwt"), undefined);
    const noClaim = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    assert.equal(chatgptAccountId(`a.${noClaim}.c`), undefined);
  });

  it("recognizes a header-owned Anthropic subscription token as OAuth", async () => {
    const model = fakeModel({ provider: "anthropic", id: "chat", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
    // `ANTHROPIC_AUTH_TOKEN`: Pi returns only the header and labels the
    // mechanism api_key, so the registry snapshot says nothing about OAuth.
    const registry = fakeRegistry({ headers: { Authorization: "Bearer sk-ant-oat-test" } }, [model]);
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.isOAuth, true);
    assert.equal(resolution.target.identity.isOAuth, true);
    assert.equal(resolution.target.identity.key.includes("|oauth|"), true);
    assert.equal(new Headers(resolution.target.originHeaders).get("authorization"), "Bearer sk-ant-oat-test");
    assert.equal(new Headers(resolution.target.originHeaders).get("x-api-key"), null);
    assert.equal(resolution.target.hasApiKey, false);
  });

  it("keeps an ordinary header-owned Anthropic bearer a non-OAuth credential", async () => {
    const model = fakeModel({ provider: "anthropic", id: "chat", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
    const registry = fakeRegistry({ headers: { Authorization: "Bearer sk-ant-api03-test" } }, [model]);
    const resolution = await resolveTarget(registry, model);
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.target.isOAuth, false);
    assert.equal(resolution.target.identity.isOAuth, false);
    assert.equal(new Headers(resolution.target.originHeaders).get("authorization"), "Bearer sk-ant-api03-test");
  });

  it("normalizes only bearer or raw authorization credentials", () => {
    assert.equal(authorizationCredential("Bearer token-a"), "token-a");
    assert.equal(authorizationCredential("bearer   token-a"), "token-a");
    assert.equal(authorizationCredential("raw-token"), "raw-token");
    assert.equal(authorizationCredential("Basic token-a"), undefined);
    assert.equal(authorizationCredential("Bearer"), undefined);
    assert.equal(authorizationCredential("Bearer token-a extra"), undefined);
  });

  it("derives account attribution from the effective authorization header", async () => {
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_effective" } }),
    ).toString("base64url");
    const model = fakeModel({ provider: "openai-codex", id: "chat", baseUrl: "https://chatgpt.com/backend-api" });
    const resolution = await resolveTarget(
      fakeRegistry(
        { apiKey: "separate-key", headers: { Authorization: `Bearer header.${claims}.signature` }, isOAuth: true },
        [model],
      ),
      model,
    );
    assert.equal(resolution.ok, true);
    if (resolution.ok) assert.equal(resolution.target.accountId, "acct_effective");
  });

  it("attaches the account id only for OAuth OpenAI credentials", async () => {
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url");
    const oauthModel = fakeModel({ provider: "openai-codex", id: "chat", baseUrl: "https://chatgpt.com/backend-api" });
    const oauth = await resolveTarget(fakeRegistry({ apiKey: `a.${claims}.c`, isOAuth: true }, [oauthModel]), oauthModel);
    assert.equal(oauth.ok, true);
    if (oauth.ok) assert.equal(oauth.target.accountId, "acct_9");

    const keyModel = fakeModel({ provider: "openai-codex", id: "chat", baseUrl: "https://chatgpt.com/backend-api" });
    const apiKey = await resolveTarget(fakeRegistry({ apiKey: `a.${claims}.c`, isOAuth: false }, [keyModel]), keyModel);
    assert.equal(apiKey.ok, true);
    if (apiKey.ok) assert.equal(apiKey.target.accountId, undefined);
  });
});

describe("model routing signature", () => {
  it("ignores header name casing and entry order", () => {
    const route = { provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1", api: "openai-responses" };
    const left = fakeModel({ ...route, headers: { "ChatGPT-Account-Id": "acct-a", "x-routing": "blue" } });
    const right = fakeModel({ ...route, headers: { "x-routing": "blue", "chatgpt-account-id": "acct-a" } });
    assert.equal(modelRoutingSignature(left), modelRoutingSignature(right));
  });

  it("separates base URL, API, and an explicitly suppressed header from an absent one", () => {
    const route = { provider: "cpa", id: "chat", baseUrl: "http://localhost:8317/v1" };
    const base = fakeModel(route);
    const otherBase = fakeModel({ ...route, baseUrl: "http://localhost:9999/v1" });
    const otherApi = fakeModel({ ...route, api: "openai-completions" });
    // Pi's header type allows `null` to suppress a provider default; runtime
    // registrations can hand such a map through a model object.
    const suppressed = fakeModel({ ...route, headers: { "x-routing": null } as unknown as Record<string, string> });
    const routed = fakeModel({ ...route, headers: { "x-routing": "blue" } });
    const signatures = [base, otherBase, otherApi, suppressed, routed].map(modelRoutingSignature);
    assert.equal(new Set(signatures).size, signatures.length);
  });
});
