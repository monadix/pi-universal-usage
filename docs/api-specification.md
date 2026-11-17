# Usage API v1

Developer contract for `pi-universal-usage/api`. Requires Node >=22.19, including
Node's native TypeScript support; no build, Pi session, runtime loader, or inference
is required. The subpath exports `createUsageClient`, `formatUsageReport`, and the
public types described below. Import and construction start no timers or network
work and do not bootstrap Pi services. The caller supplies an already configured
Pi `ModelRegistry`; Pi remains authoritative for credentials and routing.

## Client

```ts
const client = createUsageClient({
  modelRegistry,
  getActiveModel: () => selectedModel, // optional, synchronous Model | undefined
  config,                            // optional normalized UsageConfig
  // Optional deterministic seams: now: () => Unix milliseconds, fetchImpl: fetch
});
try {
  const report = await client.read({ refresh: "if-needed" });
  const text = formatUsageReport(report);
} finally {
  client.dispose();
}
```

`config` uses the existing normalized global configuration vocabulary and limits;
when omitted, load the existing global configuration, never project-local config.
There are no read-time URL, credential, endpoint, auth, or concurrency overrides.
Clock/fetch injection changes dependencies, not request safety. Construction and
reads never print, append session entries, open UI, or emit UI warnings.

`UsageClient` exposes only these operations:

- `listProviders(): ProviderInfo[]` is synchronous and network/auth-resolution free.
  Each entry is `{provider: string, enabled: boolean, active: boolean}`. Include the
  union of registered provider IDs (`getAll()`), configured IDs (also unresolved
  and disabled IDs), and the current active provider. Deduplicate and sort by ID.
  `active` means selected, not usable; enumeration promises neither credentials
  nor a supported quota endpoint. Recompute selection on each enumeration.
- `read({selection?, refresh?, signal?} = {}): Promise<UsageReport>` captures the
  selection at invocation, before asynchronous credential resolution. Default
  selection is active only, not the command's configured-provider default.
- `dispose(): void` is idempotent, ends owned work and forgets cached state.
  Subsequent reads reject and enumeration throws a fixed client-misuse Error.
  Pending reads reject on disposal; late credential resolutions/responses must
  not issue follow-on requests or restore disposed state.

`UsageSelection` is exactly one of:

```ts
{ active: true }
{ providers: readonly string[] }
{ models: readonly { provider: string; modelId: string }[] }
```

Reject malformed/mixed selections, false active, empty lists and blank IDs before
quota HTTP. Active selection without a resolver or selected model is an argument
error. IDs are exact, case-sensitive identifiers, not URLs. Duplicate provider IDs
or duplicate `(provider, modelId)` pairs collapse to their first occurrence;
results preserve first-occurrence selection order regardless of completion order.
For provider selection use its active model if any, else its first registered
model. Explicit models never silently fall back to another model. Unknown IDs are
valid selections: return `unknown`, empty metrics, missing freshness and a safe
explanation. An unresolved explicit model keeps its requested `modelId`; an
unresolved provider omits `modelId`.

A later selection change never substitutes a different model in a pending read.
A subsequent read uses the new selection. Re-resolve current credentials/routes
(including for cache-only reads) before delivering measurements: credentials,
auth overrides, account/routing headers and null suppressions must separate cache
and in-flight identities. Equivalent recased/reordered headers may share identity.
Shared account HTTP results can serve different models, but passive headers are
attributed to the producing model only. Caller mutation of a returned report
must not corrupt another report or the cache.

## Refresh, lifetime and cancellation

`UsageRefresh` is `cached | if-needed | force`; default `if-needed`.

| Mode | Contract |
| --- | --- |
| `cached` | No quota HTTP, including cold reads. Deliver safe existing measurement/failure state or explicit missing data. Credential resolution may still occur. |
| `if-needed` | Refresh absent/expired results, respecting main and optional backoff. Reuse unexpired measurements. |
| `force` | Explicit `/usage` behavior: bypass main freshness/backoff but preserve optional-endpoint retry deadlines. |

Fresh measurements are at most `refreshSeconds * 1000` ms old (inclusive).
Older measurements delivered without replacement are stale. `observedAt` is the
original HTTP/passive measurement timestamp, never the cache-access or failure
attempt time. Elapsed reset times do not make a measurement zero or replenished.
No measurement means `freshness: "missing"`, with no `observedAt` or result `source`.
Failures need not retain previous metrics; if retained, their original measurement
provenance must remain intact. `cacheHit` describes delivery without a new
measurement for that read, independently of measurement `source`. A cold missing
read is not a hit. A concurrent waiter may join the same new measurement; it is
not a second HTTP request.

Reuse existing bounded GET planning, same-origin/custom routing and credential
rules, time/body/discovery caps, retry classification and normalized metrics.
Transient errors normally back off one minute, rate limits/unavailability five
minutes, rejected credentials/unsupported endpoints thirty minutes. Respect
Retry-After up to one hour. Optional endpoint failures do not discard required
measurements. Disabled providers produce `disabled`, no metrics, missing freshness
and no requests or passive updates, even for force and active selection.

Concurrent callers for an effective account share one in-flight quota sequence.
Each report includes every selected result; provider work is bounded by normalized
`reportConcurrency` (1–8, default 3), not one unbounded Promise per provider.
Cancellation rejects that caller's wait with an Error named `AbortError`, even if
its abort reason contains private text or dependencies ignore cancellation. It
must not cancel another caller's shared request or poison the cache/backoff.
Already-aborted reads do no quota HTTP. Disposal ends work owned by the client.
Provider failures are per-result data; only invalid arguments, cancellation and
client misuse throw. Never expose arbitrary exception text in thrown errors.

## Public reports and privacy

```ts
interface UsageReport {
  schemaVersion: 1;
  generatedAt: number; // Unix milliseconds at report generation
  results: UsageResult[];
  configProblems: string[];
}
interface UsageResult {
  provider: string;
  modelId?: string;
  status: TargetStatus | "disabled";
  metrics: UsageMetric[];
  freshness: "fresh" | "stale" | "missing";
  observedAt?: number; // Unix milliseconds of ORIGINAL measurement
  source?: "http" | "headers";
  cacheHit: boolean;
  nextRetryAt?: number; // Unix milliseconds
  notice?: string;
  error?: { code: string; message: string };
}
```

`TargetStatus` retains `ok`, `unknown`, `unsupported`, `no-credential`, `rejected`,
`rate-limited`, `unavailable`, `error`. `unknown` is unresolved/missing knowledge;
`unsupported` is a resolved but unsupported endpoint/credential scheme;
`no-credential` is failed/missing credential resolution. Disabled wins over those
states without requiring auth resolution. Error codes come from a finite public
vocabulary (status names are suitable); messages are safe category explanations,
not remote bodies or resolver/network diagnostics.

Metrics retain the existing normalized whitelist: `id`, `kind`, `label`, optional
`scope`, `usedPercent`, `remainingPercent`, `used`, `limit`, `remaining`, `unit`,
`resetAtSeconds`, `durationSeconds`, `status`, `breakdown` (`{label,value}` only),
and parser `source` (scheme ID). Result source is measurement transport, whereas
metric source is parser vocabulary. Preserve subscription/request/token/budget/
balance/status distinctions and safe logical scopes (`account`, `key`, `plan`,
model dimensions), not private account identifiers. Keep finite above-100%
measurements, negative balances and elapsed resets. Omit unknown numbers: no
zero-filling, null, NaN, Infinity, inferred durations or inferred reset recovery.
A real zero remains zero. Reset/duration fields are explicitly seconds, unlike
report timestamps in milliseconds.

Reports are ordinary JSON-serializable detached values. Use an explicit whitelist,
not object spreading of internal snapshots. Never include identity keys/digests,
origins, endpoint URLs, auth metadata, account IDs, credentials, raw payloads,
headers or arbitrary internal fields, even nested inside metrics/errors.
Sanitize all public strings, including IDs, labels, scopes, units, components,
notices, config problems and errors: remove terminal/control/bidi sequences and
redact resolved secrets/private routing values wherever echoed by a provider.
The same restrictions apply to tool text, details and optional structured content.
Configuration diagnostics must not echo arbitrary invalid values containing
private data. Schema version 1 fixes field meaning, not exact prose/layout.

`formatUsageReport(report): string` is pure and deterministic using only report
values (especially `generatedAt` for relative/reset text). It does not mutate the
report, read credentials, consult wall-clock time, or perform I/O. Include useful
provider/measurement or unavailability text, preserve above-100% detail and mark
elapsed resets rather than fabricate replenishment. Sanitize even manually
constructed DTO strings; never display non-whitelisted extra properties.

## Pi tools and shared integration

Register exactly two new tools, using JSON Schema supported by the installed Pi
peer SDK and current Pi. The portable result is
`{content:[{type:"text",text: shortSummary}], details: payload}`. `details` is the
canonical structured payload directly, not an extra wrapper. `structuredContent`
may mirror it when supported; if an output schema is declared it must match.
Provider unavailability is not `isError: true` and does not throw.

- `usage_providers({})`: payload `{providers: ProviderInfo[]}`. No quota HTTP or
  auth resolution, even before session startup. Reject non-empty argument objects.
- `usage_read({providers?: string[], refresh?: UsageRefresh})`: payload
  `UsageReport`. Omitted providers selects active **only**; supplied providers
  select only those IDs, never implicitly add active/configured providers. Reject
  an empty providers list, invalid modes, malformed IDs and unknown properties.
  Forward execute's cancellation signal to the caller wait.

Descriptions explain read-only authenticated bounded quota GETs, no inference
or configuration changes; enumeration explains it does not verify usability.
Schemas disallow extra properties and exclude auth/URL/config/concurrency inputs.
Do not depend on runtime-only APIs absent from the installed peer declarations.

Within Pi, tools, `/usage`, background/footer updates and attributed passive
headers share the same account cache and in-flight work. A tool read itself has
no presentation effects, including threshold notifications. Existing command
selection (active plus enabled configured defaults; explicit command arguments
and optional active last measurement), UI modes, warning deduplication and stale
publication guards are unchanged. A model switch may suppress stale UI publication
without substituting that model into a tool report already in progress.

V1 excludes subscriptions, writes/config tools, per-provider tools, arbitrary
endpoints, a runtime loader and a CLI.

## Behavioral verification map

- `test/api.test.ts`: actual package subpath import, enumeration, selection and
  input rejection, TTL/cache/provenance/backoff, optional retries, failures,
  normalized metrics/privacy/JSON, credential/routing changes, bounded work,
  cancellation/disposal, pure formatting and import/construction side effects.
- `test/api-types.test.ts`: public named type exports, readonly selections,
  callable signatures and rejected unsafe/mixed input shapes.
- `test/extension.test.ts` (tool integration cases): registered SDK-compatible
  schemas/results, active-only vs explicit tools, no tool UI/output effects,
  passive reuse/model isolation/disabled behavior, command/background sharing,
  cancellation and privacy across returned surfaces.
- Existing auth/endpoints/http/monitor/parser/extension/warnings tests remain
  regression authority for endpoint safety, body/time/discovery bounds, wire
  normalization, selection invalidation, UI modes and deduplicated warnings.

Tests use fake registries and fetches, injected clocks and explicit gates, never
live credentials/inference/network.
