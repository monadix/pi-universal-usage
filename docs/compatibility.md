# Compatibility reference

[Back to the user guide](../README.md)

Use this reference when configuring a custom endpoint or checking whether a
proxy's usage response is supported. Most users can leave the scheme at `auto`
and let the extension select an endpoint.

## Supported schemes

Parsing is a registry of pure functions over unknown JSON or response headers.
`auto` (the default) checks structural signatures and numeric/date semantics.

| Scheme id | Input | Contract |
|---|---|---|
| `codex-json` | Codex/WHAM body | `rate_limit.primary_window` / `secondary_window`, `used_percent` (a finite, non-negative percentage), `limit_window_seconds`, `reset_at` (Unix seconds) or `reset_after_seconds`, `allowed` / `limit_reached`, optional `credits`. A `null` or absent primary window is valid (weekly-only plans). A compatible proxy can report more than 100% once an allocation is over-consumed; that over-allocation is preserved, not rejected as malformed. |
| `codex-headers` | Response headers | `x-codex-primary|secondary-used-percent` (the same finite, non-negative percentage rule), `-window-minutes`, `-reset-at`, `-reset-after-seconds`, `x-codex-credits-*`. |
| `anthropic-json` | Anthropic usage body | `five_hour`, `seven_day`, and per-model `seven_day_<model>` windows with `utilization` (0..100) and `resets_at` (ISO-8601). Window names come from the payload keys only. |
| `anthropic-headers` | Response headers | `anthropic-ratelimit-unified-5h|7d-utilization` (0..1 fraction, scaled once), `-reset` (Unix seconds), `-status` (`rejected`). |
| `rate-limit-headers` | Response headers | `x-ratelimit-limit|remaining-requests`, `-tokens`, and their duration `reset` headers; bare `x-ratelimit-limit|remaining|reset` (its reset is an absolute Unix timestamp; a value that cannot be one is ignored, never reinterpreted as a duration); `RateLimit-Limit|Remaining|Reset` with `RateLimit-Policy` (reset is delta-seconds). Request and token budgets stay distinct from subscription windows. `Retry-After` is only a retry delay, never a quota percentage. Independent header dimensions may coexist. |
| `openrouter-json` | `/api/v1/key`, `/api/v1/credits` | Key budget (`limit`, `limit_remaining`, `limit_reset`), key spend when the cap is `null`, and account credits (`total_credits` − `total_usage`). Scopes stay separate; a working key response never needs the credits response. When the credits body has `total_credits` but no usable `total_usage`, the purchased total is shown as a breakdown and the remaining balance stays unknown. |
| `deepseek-balance` | `/user/balance` | `is_available` and `balance_infos[]` with `currency`, `total_balance`, `granted_balance`, `topped_up_balance` as decimal strings. One metric per currency; zero and negative amounts are preserved. |
| `kimi-json` | Kimi Coding `/usages` | Plan `usage` bucket and `limits[]` with `detail.limit|used|remaining|resetTime` (numbers or numeric strings). Optional `window.duration`/`window.timeUnit` declares the duration; a usable bucket without a window is retained without inventing one. A bucket whose `used`/`remaining` is present but not numeric is dropped. |
| `opencode-go-json` | OpenCode Go `/zen/go/v1/usage` | `usage.rolling`, `usage.weekly`, and `usage.monthly` meters with `status`, `percent`, and `resetsAt` (ISO-8601). `percent` is consumed usage in percentage units, so `0.5` means 0.5%, not a 50% share. A missing or malformed sibling is skipped; a `rate-limited` window is reported as `limit-reached`; a finite percentage above 100 is preserved as over-allocation. No window duration is inferred. |
| `zai-json` | Z.ai quota limit | `data.limits[]` with `type` (`TOKENS_LIMIT`, `CREDIT_LIMIT`, `TIME_LIMIT`), `(unit, number)` window, `percentage` (consumed percent), `usage` (the limit), `currentValue` (consumed), `remaining`, `nextResetTime` (epoch milliseconds). The inverted naming is respected; `(unit, number)` pairs are shown verbatim rather than renamed. A response envelope with `success: false` or a non-200 `code` is rejected even if it carries limits, so an API error is never reported as usage. |

Percent scaling is explicit per scheme. Malformed or partial siblings are
skipped and reported as a notice, never turned into a full or zero value.
A finite non-negative percentage above 100 is over-allocation, not a malformed
value: the measurement keeps its reported percentage and the detailed report
notes that usage is above 100%, while the footer and compact percentages are
drawn capped at 100%. Elapsed resets are shown as `reset elapsed`, not silently
replenished.

## Endpoint selection

1. **Explicit configuration** — `providers.<id>.path` (plus `pathMode`) always
   wins and stays on the credential's origin. When the configured URL is exactly
   a documented first-party quota endpoint for that provider and origin, its
   required headers are retained (Z.ai raw key, Anthropic OAuth beta headers,
   ChatGPT account id); an arbitrary path never inherits them.
2. **First-party hints** — bound to a known provider id *and* that provider's
   exact official origin:

   | Provider ids | Official origin | Request |
   |---|---|---|
   | `openai-codex` | `https://chatgpt.com` | `GET <base>/wham/usage` |
   | `anthropic` (OAuth only) | `https://api.anthropic.com` | `GET /api/oauth/usage` (`anthropic-version`, OAuth `anthropic-beta`) |
   | `deepseek` | `https://api.deepseek.com` | `GET /user/balance` |
   | `openrouter` | `https://openrouter.ai` | `GET /api/v1/key` (+ optional `/api/v1/credits`) |
   | `kimi`, `kimi-coding`, `moonshot`, … | `https://api.kimi.com` | `GET /coding/v1/usages` (`Authorization: Bearer <coding credential>`) |
   | `opencode-go` | `https://opencode.ai` | `GET /zen/go/v1/usage` (origin root; `Authorization: Bearer`) |
   | `zai`, `glm`, `zhipu`, … | `https://api.z.ai` | `GET /api/monitor/usage/quota/limit` (raw key in `Authorization`, no `Bearer`) |

   API-key credentials for `anthropic` or `openai` have no quota interface here
   and are reported as unsupported without a request (passive response headers
   still update the footer). An Anthropic subscription token supplied through
   `ANTHROPIC_AUTH_TOKEN` arrives as a header-only bearer credential and is
   still recognized by its `sk-ant-oat` prefix, so it uses the subscription
   endpoint with the header Pi resolved. Pi's native `openai` OAuth flow obtains an
   API-audience token, which is not an established legacy ChatGPT/WHAM
   credential; `https://api.openai.com` is therefore reported as unsupported
   rather than sending that token to `chatgpt.com`. Only the legacy
   `openai-codex` provider keeps the ChatGPT host mapping. A provider registered
   as `openai` at a custom origin still uses same-origin discovery. The Z.ai
   raw-key form and the Anthropic OAuth beta header apply only on those exact
   official origins; custom origins keep the credentials and headers Pi
   resolved. Header normalization always acts on the effective authorization
   credential Pi resolved: a separately returned API key is never substituted.
   Kimi's quota endpoint requires a bearer token, so the `x-api-key` credential
   Pi's Anthropic transport resolved for an ordinary Kimi API key is normalized
   to `Authorization: Bearer`; an explicit Authorization header is kept and a
   suppressed one stays absent. OpenCode Go's quota endpoint has the same
   bearer requirement, so its hint applies the same normalization on its exact
   official origin; a custom origin keeps the credential and header form Pi
   resolved.
   An explicit `ChatGPT-Account-Id` routing header is preserved, a
   null-suppressed one stays absent, and token attribution is added only when
   neither applies. Transport defaults are synthesized per header name, so an
   auxiliary `x-api-key` does not suppress the OpenAI-compatible `Authorization`
   default; a null or empty value for that default still does.
3. **Same-origin discovery** — for an unknown provider id (for example the
   runtime-registered `cpa`) or a custom reverse-proxy origin, a bounded list of
   conservative same-origin paths is tried: `/wham/usage`,
   `/backend-api/wham/usage`, `/api/codex/usage`, `/user/balance`, `/api/v1/key`,
   `/coding/v1/usages`, `/api/monitor/usage/quota/limit`. The list is ordered by
   provider-id hints, deduplicated, and capped by `maxDiscoveryRequests`
   (default 4). The successful endpoint URL is cached per effective identity
   (provider, origin, base path, auth source, and an opaque in-memory digest of
   the resolved auth/routing headers plus their suppression metadata). Request
   headers are rebuilt on every refresh, so a rotated credential, changed
   routing header, or newly suppressed default is never replayed from the cache.

An explicit `providers.<id>.scheme` is strict: when the response does not match
that scheme, the refresh reports `unsupported` instead of trying another parser.
A headers-only scheme cannot be requested from a path and is reported without a
request.

Reverse-proxy base paths are preserved: with `pathMode: "base"` a path is joined
to the effective base path, with `"origin"` it starts at the origin root.

