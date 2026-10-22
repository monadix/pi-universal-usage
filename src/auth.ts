/**
 * Resolve the effective base URL and auth headers of a Pi model through the
 * public model registry, and derive a secret-free target identity.
 */

import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseSafeUrl, UsageUrlError } from "./http.ts";
import type { TargetIdentity } from "./types.ts";

export interface ResolvedTarget {
  identity: TargetIdentity;
  /** Effective base URL of the credential: provider base URL or the resolved auth override. */
  baseUrl: URL;
  api: string;
  /** Headers safe to send to the credential's own origin, including the auth header. */
  originHeaders: Record<string, string>;
  /**
   * Lowercased header names Pi explicitly suppressed with `null` (or an empty
   * auth header). A transport or endpoint default must not be synthesized for
   * these names, and they participate in the cache identity.
   */
  suppressedHeaders: readonly string[];
  /** True when Pi holds an OAuth/subscription credential for this provider. */
  isOAuth: boolean;
  /** ChatGPT account id extracted from an OAuth token; only sent to the vendor's own hosts. */
  accountId?: string;
  hasApiKey: boolean;
}

export type TargetResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; status: "no-credential" | "unsupported"; error: string; identity: TargetIdentity };

/** Public, credential-free messages for failures that originate in Pi's auth layer. */
export const AUTH_RESOLUTION_FAILED = "credential resolution failed for this provider";
export const NO_CREDENTIAL = "no usable credential was found for this provider";

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === name && value.trim() !== "");
}

const AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key"]);

function suppressedHeadersOf(headers: Record<string, string | null> | undefined): string[] {
  const suppressed: string[] = [];
  if (headers === undefined) return suppressed;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === null || (AUTH_HEADER_NAMES.has(lower) && value.trim() === "")) suppressed.push(lower);
  }
  return suppressed;
}

function copyHeaders(headers: Record<string, string | null> | undefined): Record<string, string> {
  const copy: Record<string, string> = {};
  if (headers === undefined) return copy;
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) continue;
    // An explicitly empty auth header suppresses Pi's transport default; it is
    // not a value to send back to the provider.
    if (AUTH_HEADER_NAMES.has(name.toLowerCase()) && value.trim() === "") continue;
    copy[name] = value;
  }
  return copy;
}

/**
 * Anthropic credentials use `x-api-key` for API keys and a bearer token for
 * OAuth access tokens (Claude Pro/Max), matching Pi's own Anthropic transport.
 */
export function anthropicAuthHeaders(apiKey: string): Record<string, string> {
  if (apiKey.includes("sk-ant-oat")) return { authorization: `Bearer ${apiKey}` };
  return { "x-api-key": apiKey };
}

const AUTH_SCHEME_NAMES = new Set(["basic", "bearer", "digest", "hoba", "negotiate"]);

/**
 * Pi identifies an Anthropic subscription token by its `sk-ant-oat` prefix.
 * Such a token can arrive either as the resolved API key or, for
 * `ANTHROPIC_AUTH_TOKEN`, only as an effective `Authorization: Bearer` header.
 */
function isAnthropicSubscriptionToken(model: Model<any>, credential: string | undefined): boolean {
  return model.api === "anthropic-messages" && credential !== undefined && credential.includes("sk-ant-oat");
}

/**
 * The credential carried by an effective `Authorization` header. `Bearer`
 * tokens and raw token values are returned; an unrelated auth scheme is
 * undefined because its payload is not a credential this package understands.
 */
export function authorizationCredential(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const separator = trimmed.search(/\s/u);
  if (separator === -1) {
    // A bare auth scheme names no credential; every other raw value is treated
    // as the token itself, matching endpoints that expect no scheme prefix.
    return AUTH_SCHEME_NAMES.has(trimmed.toLowerCase()) ? undefined : trimmed;
  }
  const scheme = trimmed.slice(0, separator).toLowerCase();
  const token = trimmed.slice(separator).trim();
  if (scheme !== "bearer" || token === "" || /\s/u.test(token)) return undefined;
  return token;
}

function authorizationHeaderValue(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") return value;
  }
  return undefined;
}

/** `chatgpt_account_id` from the JWT claims of a ChatGPT OAuth access token, when present. */
export function chatgptAccountId(apiKey: string): string | undefined {
  const parts = apiKey.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return undefined;
    const auth = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId !== "" ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function basePathOf(url: URL): string {
  const path = url.pathname.replace(/\/+$/u, "");
  return path === "" ? "/" : path;
}

/**
 * Opaque in-memory fingerprint of the effective auth and routing headers. It
 * separates cache entries when a credential rotates, a model-level header
 * changes, or a default header is suppressed, without changing the provider,
 * origin, or auth-source label. The digest is never printed or persisted.
 */
export function authFingerprint(
  baseUrl: URL,
  headers: Record<string, string>,
  suppressedHeaders: readonly string[] = [],
): string {
  const canonical = [
    baseUrl.href,
    `suppressed:${[...suppressedHeaders].sort().join(",")}`,
    ...Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).sort(),
  ];
  return createHash("sha256").update(canonical.join("\n")).digest("hex").slice(0, 16);
}

function identityFor(
  model: Model<any>,
  baseUrl: URL,
  isOAuth: boolean,
  authSource: string,
  fingerprint: string,
): TargetIdentity {
  return {
    key: [model.provider, baseUrl.origin, basePathOf(baseUrl), authSource, isOAuth ? "oauth" : "key", model.api, fingerprint].join("|"),
    providerId: model.provider,
    modelId: model.id,
    origin: baseUrl.origin,
    basePath: basePathOf(baseUrl),
    authSource,
    isOAuth,
  };
}

function authStatusSource(registry: ModelRegistry, providerId: string): string {
  try {
    return registry.getProviderAuthStatus(providerId)?.source ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Base URL parsing shared by the model's and the auth override's URLs. */
function safeBase(raw: string, options: { allowInsecureHttp?: boolean }, label: string): URL | string {
  try {
    return parseSafeUrl(raw, options);
  } catch (error) {
    const message = error instanceof UsageUrlError ? error.message : "invalid base URL";
    return `${label} is not usable: ${message}`;
  }
}

/**
 * Resolve a model's effective request identity. The effective base URL comes
 * from Pi's auth resolution when it overrides the model base URL. Auth-layer
 * failures are replaced with fixed public messages: resolver diagnostics may
 * carry response bodies, URLs, or credential fragments.
 */
export async function resolveTarget(
  registry: ModelRegistry,
  model: Model<any>,
  options: { allowInsecureHttp?: boolean } = {},
): Promise<TargetResolution> {
  const parsedBase = safeBase(model.baseUrl, options, "Provider base URL");
  if (typeof parsedBase === "string") {
    return {
      ok: false,
      status: "unsupported",
      error: parsedBase,
      identity: {
        key: `${model.provider}|invalid|${model.api}`,
        providerId: model.provider,
        modelId: model.id,
        origin: "",
        basePath: "/",
        authSource: "unknown",
        isOAuth: false,
      },
    };
  }

  let resolved;
  try {
    resolved = await registry.getApiKeyAndHeaders(model);
  } catch {
    return {
      ok: false,
      status: "no-credential",
      error: AUTH_RESOLUTION_FAILED,
      identity: identityFor(model, parsedBase, false, "unknown", authFingerprint(parsedBase, {})),
    };
  }

  const authSource = authStatusSource(registry, model.provider);
  const apiKeyValue = resolved.ok ? resolved.apiKey : undefined;
  // Pi's auth snapshot is authoritative; the Anthropic OAuth token prefix is an
  // additional wire-level signal when that snapshot is not available yet.
  let isOAuth = false;
  try {
    isOAuth = registry.isUsingOAuth(model) || isAnthropicSubscriptionToken(model, apiKeyValue);
  } catch {
    isOAuth = isAnthropicSubscriptionToken(model, apiKeyValue);
  }

  let effectiveBase = parsedBase;
  if (resolved.ok && resolved.baseUrl !== undefined) {
    const parsedOverride = safeBase(resolved.baseUrl, options, "Resolved auth base URL");
    if (typeof parsedOverride === "string") {
      return {
        ok: false,
        status: "unsupported",
        error: parsedOverride,
        identity: identityFor(model, parsedBase, isOAuth, authSource, authFingerprint(parsedBase, {})),
      };
    }
    effectiveBase = parsedOverride;
  }

  if (!resolved.ok) {
    return {
      ok: false,
      status: "no-credential",
      error: NO_CREDENTIAL,
      identity: identityFor(model, effectiveBase, isOAuth, authSource, authFingerprint(effectiveBase, {})),
    };
  }

  const suppressedHeaders = suppressedHeadersOf(resolved.headers);
  const originHeaders = copyHeaders(resolved.headers);
  const apiKey = resolved.apiKey;
  if (apiKey !== undefined && apiKey !== "") {
    const defaultAuthHeaders =
      model.api === "anthropic-messages" ? anthropicAuthHeaders(apiKey) : { authorization: `Bearer ${apiKey}` };
    // Synthesize only the header name this transport defaults to. An unrelated
    // auth header, such as an auxiliary x-api-key, does not suppress it.
    for (const [name, value] of Object.entries(defaultAuthHeaders)) {
      const lower = name.toLowerCase();
      if (suppressedHeaders.includes(lower) || hasHeader(originHeaders, lower)) continue;
      originHeaders[name] = value;
    }
  }

  // Pi's header-owned auth path (`ANTHROPIC_AUTH_TOKEN`) returns only
  // `headers.Authorization` and is reported as the api_key mechanism, so the
  // registry snapshot cannot identify the subscription token it carries.
  const effectiveAuthorization = authorizationHeaderValue(originHeaders);
  const effectiveToken = effectiveAuthorization !== undefined ? authorizationCredential(effectiveAuthorization) : undefined;
  if (isAnthropicSubscriptionToken(model, effectiveToken)) isOAuth = true;

  const identity = identityFor(
    model,
    effectiveBase,
    isOAuth,
    authSource,
    authFingerprint(effectiveBase, originHeaders, suppressedHeaders),
  );
  // Account attribution belongs to the token Pi actually sends, not to a
  // separately returned API key that endpoint planning must never substitute.
  const accountId =
    isOAuth && (model.provider === "openai-codex" || model.provider === "openai") && effectiveToken !== undefined
      ? chatgptAccountId(effectiveToken)
      : undefined;

  return {
    ok: true,
    target: {
      identity,
      baseUrl: effectiveBase,
      api: model.api,
      originHeaders,
      suppressedHeaders,
      isOAuth,
      ...(accountId !== undefined ? { accountId } : {}),
      hasApiKey: apiKey !== undefined && apiKey !== "",
    },
  };
}
