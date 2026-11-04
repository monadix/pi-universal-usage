/**
 * Endpoint selection, kept separate from scheme detection.
 *
 * Three ways an endpoint is chosen:
 *  1. An explicit per-provider `path` from the configuration file (same origin
 *     as the credential, `base` or `origin` path mode).
 *  2. A first-party hint: a small table bound to a known provider id *and* that
 *     provider's exact official origin. A hint may report that the first-party
 *     auth flow has no compatible quota endpoint (native OpenAI OAuth) instead
 *     of planning a request.
 *  3. Conservative same-origin discovery for unknown provider ids or custom
 *     reverse-proxy origins, bounded by `maxDiscoveryRequests`.
 *
 * Parser selection never happens here: discovery requests parse with the whole
 * registry, and every planned request carries only an optional scheme hint.
 */

import type { SchemeId, TargetIdentity, TargetStatus } from "./types.ts";
import { schemeIsHeadersOnly } from "./registry.ts";
import type { ProviderConfig, UsageConfig } from "./config.ts";
import { authorizationCredential, type ResolvedTarget } from "./auth.ts";

export interface EndpointPath {
  path: string;
  mode: "base" | "origin";
  label: string;
  /** Failure of an optional request never hides a successful required one. */
  optional?: boolean;
}

interface FirstPartyHint {
  providerIds: readonly string[];
  officialOrigins: readonly string[];
  /** When set, only OAuth/subscription credentials may use this hint. */
  requiresOAuth?: boolean;
  /** No request is planned for this first-party auth flow; report this notice instead. */
  unsupportedNotice?: string;
  scheme: SchemeId;
  sameOrigin?: readonly EndpointPath[];
  crossOrigin?: { origin: string; paths: readonly EndpointPath[] };
  /** Non-secret protocol headers the endpoint requires. */
  protocolHeaders?: Record<string, string>;
  /** The endpoint expects the raw credential in `authorization` (no scheme prefix). */
  rawAuthorization?: boolean;
  /** The endpoint expects the effective credential as `Authorization: Bearer`. */
  bearerAuthorization?: boolean;
  /** Send the ChatGPT account id header extracted from the OAuth token. */
  accountIdHeader?: boolean;
}

const CODEX_JSON_SCHEME: SchemeId = "codex-json";

export const FIRST_PARTY_HINTS: readonly FirstPartyHint[] = [
  {
    providerIds: ["openai-codex"],
    officialOrigins: ["https://chatgpt.com"],
    scheme: CODEX_JSON_SCHEME,
    sameOrigin: [{ path: "/wham/usage", mode: "base", label: "codex usage" }],
    accountIdHeader: true,
  },
  {
    // Pi's native `openai` provider uses an API-audience ChatGPT OAuth token.
    // That token is not an established legacy ChatGPT/WHAM credential, so this
    // official origin gets passive headers only. A provider registered at a
    // different origin still uses bounded same-origin discovery.
    providerIds: ["openai"],
    officialOrigins: ["https://api.openai.com"],
    scheme: CODEX_JSON_SCHEME,
    unsupportedNotice:
      "The native OpenAI OAuth flow uses an API-audience token, not a legacy ChatGPT/WHAM credential; " +
      "no subscription quota endpoint is requested for this origin. Passive rate-limit headers only.",
  },
  {
    providerIds: ["anthropic"],
    officialOrigins: ["https://api.anthropic.com"],
    requiresOAuth: true,
    scheme: "anthropic-json",
    sameOrigin: [{ path: "/api/oauth/usage", mode: "origin", label: "anthropic usage" }],
    protocolHeaders: { "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
  },
  {
    providerIds: ["deepseek"],
    officialOrigins: ["https://api.deepseek.com"],
    scheme: "deepseek-balance",
    sameOrigin: [{ path: "/user/balance", mode: "origin", label: "deepseek balance" }],
  },
  {
    providerIds: ["openrouter"],
    officialOrigins: ["https://openrouter.ai"],
    scheme: "openrouter-json",
    sameOrigin: [
      { path: "/api/v1/key", mode: "origin", label: "openrouter key" },
      { path: "/api/v1/credits", mode: "origin", label: "openrouter credits", optional: true },
    ],
  },
  {
    providerIds: ["kimi", "kimi-coding", "kimi-for-coding", "moonshot", "moonshotai"],
    officialOrigins: ["https://api.kimi.com"],
    scheme: "kimi-json",
    sameOrigin: [{ path: "/coding/v1/usages", mode: "origin", label: "kimi coding usage" }],
    bearerAuthorization: true,
  },
  {
    // OpenCode Go models may use Pi's Anthropic transport, which resolves an
    // API key as `x-api-key`; its quota endpoint requires a bearer credential.
    providerIds: ["opencode-go"],
    officialOrigins: ["https://opencode.ai"],
    scheme: "opencode-go-json",
    sameOrigin: [{ path: "/zen/go/v1/usage", mode: "origin", label: "opencode go usage" }],
    bearerAuthorization: true,
  },
  {
    providerIds: ["zai", "z-ai", "zai-coding-plan", "glm", "zhipu", "zhipuai"],
    officialOrigins: ["https://api.z.ai"],
    scheme: "zai-json",
    sameOrigin: [{ path: "/api/monitor/usage/quota/limit", mode: "origin", label: "z.ai quota" }],
    rawAuthorization: true,
  },
];

interface DiscoveryCandidate {
  path: string;
  mode: "base" | "origin";
  label: string;
  /** Provider-id hint used only to order same-origin candidates. */
  providers?: RegExp;
}

/**
 * Same-origin candidates for an unknown provider or a custom proxy origin. The
 * provider-id regexes only reorder these requests; they never authorize a
 * different origin, so a custom credential can only reach the host it is
 * already bound to.
 */
export const DISCOVERY_CANDIDATES: readonly DiscoveryCandidate[] = [
  { path: "/wham/usage", mode: "base", label: "codex usage (base path)", providers: /codex|cpa|cliproxy|proxy/ },
  { path: "/backend-api/wham/usage", mode: "origin", label: "codex usage (origin root)", providers: /codex|cpa|cliproxy|proxy/ },
  { path: "/api/codex/usage", mode: "origin", label: "codex usage alias", providers: /codex|cpa|cliproxy/ },
  { path: "/wham/usage", mode: "origin", label: "codex usage alias", providers: /codex|cpa|cliproxy/ },
  { path: "/user/balance", mode: "base", label: "balance (base path)", providers: /deepseek/ },
  { path: "/user/balance", mode: "origin", label: "balance (origin root)", providers: /deepseek/ },
  { path: "/api/v1/key", mode: "origin", label: "key budget", providers: /openrouter/ },
  { path: "/api/v1/credits", mode: "origin", label: "account credits", providers: /openrouter/ },
  { path: "/key", mode: "base", label: "key budget (base path)", providers: /openrouter/ },
  { path: "/coding/v1/usages", mode: "origin", label: "coding usages", providers: /kimi|moonshot/ },
  { path: "/usages", mode: "base", label: "coding usages (base path)", providers: /kimi|moonshot/ },
  { path: "/api/monitor/usage/quota/limit", mode: "origin", label: "quota limit", providers: /zai|glm|zhipu/ },
];

export interface PlannedRequest {
  url: URL;
  allowedOrigins: readonly string[];
  /** Parser to use; undefined means "detect from the response". */
  scheme?: SchemeId;
  /** `scheme` came from the user's configuration, so no other parser may be tried. */
  strictScheme?: boolean;
  optional?: boolean;
  label: string;
  headers: Record<string, string>;
}

export type EndpointPlan =
  | { kind: "requests"; requests: PlannedRequest[]; discovery: boolean }
  | { kind: "none"; status: TargetStatus; notice: string };

function cleanPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** Resolve a configured path against the effective base URL or its origin root. */
export function joinEndpoint(base: URL, path: string, mode: "base" | "origin"): URL {
  const target = cleanPath(path);
  if (mode === "origin") return new URL(target, base.origin);
  const prefix = base.pathname.replace(/\/+$/u, "");
  return new URL(`${prefix}${target}`, base.origin);
}

function authOnlyHeaders(headers: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") selected[name] = value;
  }
  return selected;
}

/** Replace a header regardless of the casing Pi or a provider used. */
function replaceHeader(headers: Record<string, string>, name: string, value: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
  headers[name] = value;
}

/** Read an effective header regardless of the casing Pi or a provider used. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

const UNNORMALIZABLE_AUTHORIZATION_NOTICE =
  "This endpoint requires a raw Authorization credential, but the effective authorization header uses an unsupported auth scheme; no request was made.";

class EndpointAuthError extends Error {
  constructor() {
    super(UNNORMALIZABLE_AUTHORIZATION_NOTICE);
    this.name = "EndpointAuthError";
  }
}

function applyProtocolHeaders(headers: Record<string, string>, hint: FirstPartyHint | undefined): void {
  for (const [name, value] of Object.entries(hint?.protocolHeaders ?? {})) replaceHeader(headers, name, value);
}

function authHeaderSuppressed(target: ResolvedTarget, name: string): boolean {
  return target.suppressedHeaders.includes(name.toLowerCase());
}

function sameOriginHeaders(target: ResolvedTarget, hint: FirstPartyHint | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...target.originHeaders };
  applyProtocolHeaders(headers, hint);
  if (hint?.rawAuthorization === true && !authHeaderSuppressed(target, "authorization")) {
    const effective = headerValue(headers, "authorization");
    const normalized = effective !== undefined ? authorizationCredential(effective) : undefined;
    // The endpoint's raw form must be derived from the credential Pi actually
    // sends; a separate API key would describe a different account.
    if (normalized === undefined) throw new EndpointAuthError();
    replaceHeader(headers, "authorization", normalized);
  }
  applyBearerAuthorization(headers, target, hint);
  applyAccountIdHeader(headers, target, hint);
  return headers;
}

/**
 * Some first-party quota endpoints (Kimi Coding, OpenCode Go) take the plan
 * credential as a bearer token, but Pi's `anthropic-messages` transport
 * resolves an ordinary API key as `x-api-key`. Normalize that effective
 * credential into the required header. An explicit Authorization is the
 * credential Pi already sends and wins; a suppressed one stays absent.
 */
function applyBearerAuthorization(
  headers: Record<string, string>,
  target: ResolvedTarget,
  hint: FirstPartyHint | undefined,
): void {
  if (hint?.bearerAuthorization !== true) return;
  if (authHeaderSuppressed(target, "authorization")) return;
  if (headerValue(headers, "authorization") !== undefined) return;
  const credential = headerValue(headers, "x-api-key")?.trim();
  if (credential === undefined || credential === "") return;
  replaceHeader(headers, "authorization", `Bearer ${credential}`);
}

function applyAccountIdHeader(
  headers: Record<string, string>,
  target: ResolvedTarget,
  hint: FirstPartyHint | undefined,
): void {
  if (hint?.accountIdHeader !== true) return;
  // An explicit routing header wins; a null-suppressed one stays absent, and
  // attribution is synthesized only when neither applies.
  if (headerValue(headers, "chatgpt-account-id") !== undefined) return;
  if (target.suppressedHeaders.includes("chatgpt-account-id")) return;
  if (target.accountId !== undefined) replaceHeader(headers, "chatgpt-account-id", target.accountId);
}

function crossOriginHeaders(target: ResolvedTarget, hint: FirstPartyHint): Record<string, string> {
  const headers: Record<string, string> = authOnlyHeaders(target.originHeaders);
  applyProtocolHeaders(headers, hint);
  if (hint.accountIdHeader === true) {
    const explicit = headerValue(target.originHeaders, "chatgpt-account-id");
    if (explicit !== undefined) replaceHeader(headers, "chatgpt-account-id", explicit);
  }
  applyAccountIdHeader(headers, target, hint);
  return headers;
}

function hintApplies(hint: FirstPartyHint, identity: TargetIdentity): boolean {
  return hint.providerIds.includes(identity.providerId) && hint.officialOrigins.includes(identity.origin);
}

/** Compare endpoint URLs by origin and path; a query never changes the endpoint's identity. */
function endpointKey(url: URL): string {
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path === "" ? "/" : path}`;
}

/**
 * A trusted first-party hint whose documented endpoint an explicit path
 * reproduces. Matching is by resolved same-origin URL under the same provider,
 * origin, and auth constraints, so an arbitrary configured path never inherits
 * endpoint-specific header rules.
 */
function hintForExplicitEndpoint(target: ResolvedTarget, url: URL): FirstPartyHint | undefined {
  for (const hint of FIRST_PARTY_HINTS) {
    if (!hintApplies(hint, target.identity)) continue;
    if (hint.requiresOAuth === true && !target.isOAuth) continue;
    for (const entry of hint.sameOrigin ?? []) {
      if (endpointKey(joinEndpoint(target.baseUrl, entry.path, entry.mode)) === endpointKey(url)) return hint;
    }
  }
  return undefined;
}

function requestsForPaths(
  base: URL,
  paths: readonly EndpointPath[],
  scheme: SchemeId,
  options: { allowedOrigins: string[]; headers: Record<string, string>; pathModeOverride?: "base" | "origin"; schemeOverride?: SchemeId | "auto" },
): PlannedRequest[] {
  const override = options.schemeOverride !== undefined && options.schemeOverride !== "auto" ? options.schemeOverride : undefined;
  return paths.map((entry) => {
    const mode = options.pathModeOverride ?? entry.mode;
    return {
      url: joinEndpoint(base, entry.path, mode),
      allowedOrigins: options.allowedOrigins,
      scheme: override ?? scheme,
      ...(override !== undefined ? { strictScheme: true } : {}),
      ...(entry.optional === true ? { optional: true } : {}),
      label: entry.label,
      headers: options.headers,
    };
  });
}

function planEndpointsForTarget(
  target: ResolvedTarget,
  provider: ProviderConfig | undefined,
  config: UsageConfig,
): EndpointPlan {
  const identity = target.identity;
  const sameOrigin = [identity.origin];
  const configuredScheme = provider?.scheme !== undefined && provider.scheme !== "auto" ? provider.scheme : undefined;

  // A headers-only selection cannot be requested from any path, whether or not
  // one is configured, and must not fall through to discovery.
  if (configuredScheme !== undefined && schemeIsHeadersOnly(configuredScheme)) {
    return {
      kind: "none",
      status: "unsupported",
      notice: `Scheme ${configuredScheme} reads response headers; it cannot be requested from a path.`,
    };
  }

  if (provider?.path !== undefined) {
    const url = joinEndpoint(target.baseUrl, provider.path, provider.pathMode ?? "base");
    // Pinning the same trusted endpoint must not drop its required protocol
    // headers (Anthropic OAuth beta, Z.ai raw key, ChatGPT account id).
    const matchedHint = hintForExplicitEndpoint(target, url);
    return {
      kind: "requests",
      discovery: false,
      requests: [
        {
          url,
          allowedOrigins: sameOrigin,
          ...(configuredScheme !== undefined ? { scheme: configuredScheme, strictScheme: true } : {}),
          label: "configured path",
          headers: sameOriginHeaders(target, matchedHint),
        },
      ],
    };
  }

  const hint = FIRST_PARTY_HINTS.find((candidate) => hintApplies(candidate, identity));
  if (hint !== undefined) {
    if (hint.unsupportedNotice !== undefined) {
      return { kind: "none", status: "unsupported", notice: hint.unsupportedNotice };
    }
    const oauthOk = hint.requiresOAuth !== true || target.isOAuth;
    if (!oauthOk) {
      return {
        kind: "none",
        status: "unsupported",
        notice:
          "This provider exposes a subscription quota endpoint only for OAuth credentials; " +
          "API-key credentials have no quota interface here.",
      };
    }
    const schemeOverride = provider?.scheme;
    if (hint.crossOrigin !== undefined) {
      const crossBase = new URL(hint.crossOrigin.origin);
      const requests = requestsForPaths(crossBase, hint.crossOrigin.paths, hint.scheme, {
        allowedOrigins: [crossBase.origin],
        headers: crossOriginHeaders(target, hint),
        pathModeOverride: "origin",
        ...(schemeOverride !== undefined ? { schemeOverride } : {}),
      });
      return { kind: "requests", discovery: false, requests };
    }
    const requests = requestsForPaths(target.baseUrl, hint.sameOrigin ?? [], hint.scheme, {
      allowedOrigins: sameOrigin,
      headers: sameOriginHeaders(target, hint),
      ...(schemeOverride !== undefined ? { schemeOverride } : {}),
    });
    return { kind: "requests", discovery: false, requests };
  }

  const knownFirstParty = FIRST_PARTY_HINTS.some(
    (candidate) => candidate.providerIds.includes(identity.providerId) && candidate.officialOrigins.includes(identity.origin),
  );
  if (knownFirstParty) {
    return {
      kind: "none",
      status: "unsupported",
      notice: "No quota endpoint is known for this provider and auth method; passive rate-limit headers only.",
    };
  }

  const ordered = [...DISCOVERY_CANDIDATES].sort((left, right) => {
    const leftHint = left.providers?.test(identity.providerId) === true ? 0 : 1;
    const rightHint = right.providers?.test(identity.providerId) === true ? 0 : 1;
    return leftHint - rightHint;
  });

  const seen = new Set<string>();
  const requests: PlannedRequest[] = [];
  for (const candidate of ordered) {
    const url = joinEndpoint(target.baseUrl, candidate.path, candidate.mode);
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    requests.push({
      url,
      allowedOrigins: sameOrigin,
      ...(configuredScheme !== undefined ? { scheme: configuredScheme, strictScheme: true } : {}),
      label: candidate.label,
      headers: sameOriginHeaders(target, undefined),
    });
    if (requests.length >= config.maxDiscoveryRequests) break;
  }
  if (requests.length === 0) {
    return { kind: "none", status: "unsupported", notice: "No same-origin endpoint candidates are configured." };
  }
  return { kind: "requests", discovery: true, requests };
}

/**
 * Plan the read-only requests for one target. Paths come from the user's
 * configuration and the credential's base URL, so a URL-construction failure
 * becomes a sanitized diagnostic line: a refresh or `/usage` must report the
 * problem instead of rejecting.
 */
export function planEndpoints(
  target: ResolvedTarget,
  provider: ProviderConfig | undefined,
  config: UsageConfig,
): EndpointPlan {
  try {
    return planEndpointsForTarget(target, provider, config);
  } catch (error) {
    return {
      kind: "none",
      status: "unsupported",
      notice:
        error instanceof EndpointAuthError
          ? error.message
          : "This provider's endpoint could not be resolved to a valid URL; no request was made.",
    };
  }
}
