# pi-universal-usage

A small, read-only usage monitor for the [Pi coding agent](https://pi.dev). It
shows subscription quota windows, request/token rate-limit budgets, key budgets,
and account balances for the provider you are using, and can report on other
providers you opt into.

It is provider-ID independent: a pure parser registry recognises popular
quota-compatibility wire formats, and endpoint selection is a separate, bounded
step. Unknown stays unknown; nothing is reported as `0%` because a field was
missing.

## Guarantees

- **Read-only.** Only `GET` requests, no inference calls, no request-payload
  rewriting, no model probes, no browser scraping, no management credentials.
- **Credential-scoped.** Requests go to the origin Pi resolved for the model's
  credential. Redirects are refused (the refused response body is closed), URLs
  with userinfo are refused, body size and time are bounded, and custom
  credentials never travel to a vendor's official host. The effective credential
  and base URL are re-resolved on every refresh; only the endpoint path is
  cached, never a credential-bearing request.
- **No hidden network at load.** The extension factory only registers handlers
  and reads configuration. Network reads start at session start, `/usage`, a
  model switch, a turn end (throttled), or in TUI mode on a throttled timer.
- **No secrets in configuration or output.** The config file has no credential
  fields; reports show provider, scheme, endpoint path, percentages, amounts,
  and reset times. Remotely supplied text is stripped of terminal escape and
  control sequences before it reaches the footer or report.

## Load it

Try it for one invocation without installing anything:

```sh
pi -e /absolute/path/to/pi-universal-usage
```

Or install the package as usual (`pi install ./pi-universal-usage`). The
extension entry point is `extensions/index.ts`; Pi loads the TypeScript directly.

## Use it

- `/usage` — refresh the active provider and every provider listed in your
  configuration, then show the detailed report. Accepts provider ids:
  `/usage deepseek`, `/usage deepseek cpa`.
- The footer shows a compact line for the active provider, for example
  `cpa: weekly 42% · reset 2d 3h` or `deepseek: USD $8.82`. An elapsed window is
  qualified as `reset elapsed` on its own metric, the nearest future reset is
  summarized, and a snapshot older than twice the refresh interval is marked
  `stale`.

The detailed report shows state, scheme, endpoint path, freshness, one line per
metric with scope and reset, plus any notice (for example CPA shadow quota mode)
or error.

`/usage` is the actual command name. If another extension already registered
`/usage`, Pi reports the conflict; disable one of the two.

## Supported schemes

Parsing is a registry of pure functions over unknown JSON or response headers.
`auto` (the default) checks structural signatures and numeric/date semantics.

| Scheme id | Input | Contract |
|---|---|---|
| `codex-json` | Codex/WHAM body | `rate_limit.primary_window` / `secondary_window`, `used_percent` (0..100), `limit_window_seconds`, `reset_at` (Unix seconds) or `reset_after_seconds`, `allowed` / `limit_reached`, optional `credits`. A `null` or absent primary window is valid (weekly-only plans). |
| `codex-headers` | Response headers | `x-codex-primary|secondary-used-percent`, `-window-minutes`, `-reset-at`, `-reset-after-seconds`, `x-codex-credits-*`. |
| `anthropic-json` | Anthropic usage body | `five_hour`, `seven_day`, and per-model `seven_day_<model>` windows with `utilization` (0..100) and `resets_at` (ISO-8601). Window names come from the payload keys only. |
| `anthropic-headers` | Response headers | `anthropic-ratelimit-unified-5h|7d-utilization` (0..1 fraction, scaled once), `-reset` (Unix seconds), `-status` (`rejected`). |
| `rate-limit-headers` | Response headers | `x-ratelimit-limit|remaining-requests`, `-tokens`, and their duration `reset` headers; bare `x-ratelimit-limit|remaining|reset` (its reset is an absolute Unix timestamp; a value that cannot be one is ignored, never reinterpreted as a duration); `RateLimit-Limit|Remaining|Reset` with `RateLimit-Policy` (reset is delta-seconds). Request and token budgets stay distinct from subscription windows. `Retry-After` is only a retry delay, never a quota percentage. Independent header dimensions may coexist. |
| `openrouter-json` | `/api/v1/key`, `/api/v1/credits` | Key budget (`limit`, `limit_remaining`, `limit_reset`), key spend when the cap is `null`, and account credits (`total_credits` − `total_usage`). Scopes stay separate; a working key response never needs the credits response. When the credits body has `total_credits` but no usable `total_usage`, the purchased total is shown as a breakdown and the remaining balance stays unknown. |
| `deepseek-balance` | `/user/balance` | `is_available` and `balance_infos[]` with `currency`, `total_balance`, `granted_balance`, `topped_up_balance` as decimal strings. One metric per currency; zero and negative amounts are preserved. |
| `kimi-json` | Kimi Coding `/usages` | Plan `usage` bucket and `limits[]` with `window.duration`/`window.timeUnit` and `detail.limit|used|remaining|resetTime` (numbers or numeric strings). A bucket whose `used`/`remaining` is present but not numeric is dropped. |
| `zai-json` | Z.ai quota limit | `data.limits[]` with `type` (`TOKENS_LIMIT`, `CREDIT_LIMIT`, `TIME_LIMIT`), `(unit, number)` window, `percentage` (consumed percent), `usage` (the limit), `currentValue` (consumed), `remaining`, `nextResetTime` (epoch milliseconds). The inverted naming is respected; `(unit, number)` pairs are shown verbatim rather than renamed. A response envelope with `success: false` or a non-200 `code` is rejected even if it carries limits, so an API error is never reported as usage. |

Percent scaling is explicit per scheme. Malformed or partial siblings are
skipped and reported as a notice, never turned into a full or zero value.
Elapsed resets are shown as `reset elapsed`, not silently replenished.

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
   | `kimi`, `kimi-coding`, `moonshot`, … | `https://api.kimi.com` | `GET /coding/v1/usages` |
   | `zai`, `glm`, `zhipu`, … | `https://api.z.ai` | `GET /api/monitor/usage/quota/limit` (raw key in `Authorization`, no `Bearer`) |

   API-key credentials for `anthropic` or `openai` have no quota interface here
   and are reported as unsupported without a request (passive response headers
   still update the footer). Pi's native `openai` OAuth flow obtains an
   API-audience token, which is not an established legacy ChatGPT/WHAM
   credential; `https://api.openai.com` is therefore reported as unsupported
   rather than sending that token to `chatgpt.com`. Only the legacy
   `openai-codex` provider keeps the ChatGPT host mapping. A provider registered
   as `openai` at a custom origin still uses same-origin discovery. The Z.ai
   raw-key form and the Anthropic OAuth beta header apply only on those exact
   official origins; custom origins keep the credentials and headers Pi
   resolved. Header normalization always acts on the effective authorization
   credential Pi resolved: a separately returned API key is never substituted.
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

### CPA (CLIProxyAPI) example

Zero configuration is usually enough: a `cpa` provider at
`http://localhost:8317/v1` is discovered through same-origin probing, because
CLIProxyAPI serves `/backend-api/wham/usage`, `/wham/usage`, and
`/api/codex/usage` at the origin root. To skip discovery and pin the endpoint:

```json
{
  "providers": {
    "cpa": {
      "scheme": "auto",
      "path": "/backend-api/wham/usage",
      "pathMode": "origin"
    }
  }
}
```

CPA's Codex status body is weekly-only (`primary_window: null`,
`secondary_window` populated) and reports `plan_type: "unknown"` with
`quota_mode: "shadow"` or `"enforce"`. Shadow mode is preserved as a notice:
the report says the quota is advisory and not enforced. HTTP 503 with
`status_unavailable` is reported as unavailable, not as 0%.

## Configuration

Global file only: `<agent dir>/pi-universal-usage.json`, where the agent dir is
Pi's `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). A project-local file is
deliberately ignored: a repository must not be able to redirect credentialed
requests. The file contains no secrets; every field is optional.

```json
{
  "refreshSeconds": 300,
  "minRefreshSeconds": 60,
  "timeoutMs": 8000,
  "maxBodyBytes": 262144,
  "maxDiscoveryRequests": 4,
  "autoRefresh": true,
  "providers": {
    "cpa": { "path": "/backend-api/wham/usage", "pathMode": "origin" },
    "deepseek": { "enabled": true },
    "openrouter": { "scheme": "auto" }
  }
}
```

Per provider: `enabled` (default `true`), `scheme`
(`auto` or a scheme id), `path` (absolute same-origin path), `pathMode`
(`base` | `origin`, default `base`). `path` must be a plain path such as
`/wham/usage`: a network-path (`//host/...`), backslash, scheme, or userinfo
form is rejected. Invalid entries are ignored with a note in the report; they
never cause a crash or a different origin. `timeoutMs` and
`maxBodyBytes` are validated and applied to every request (the live smoke uses
the same configuration). Timer-backed values are bounded by Node's maximum
timer delay: `refreshSeconds` and `minRefreshSeconds` are at most
2147483 seconds, and `timeoutMs` is at most 2147483647 milliseconds. A larger
value falls back to its default with a configuration problem instead of
creating a 1 ms timer.

## Behaviour details

- Endpoint success is cached; failures are cached with backoff (60 s for a
  transient error, 5 min for a rate limit or unavailable service, 30 min for
  rejected credentials or an unsupported provider). `Retry-After` is honored up
  to one hour. An optional sibling endpoint (for example OpenRouter account
  credits) keeps its own retry deadline after a 429 or 503, so it is not
  re-requested early while the required result keeps refreshing. `/usage` forces
  a refresh.
- Concurrent refreshes for the same identity share one request sequence. The
  active provider is re-resolved before each refresh, so rotated credentials and
  changed auth base URLs take effect without a restart.
- `after_provider_response` headers update the footer only while Pi is busy,
  only when a `turn_start` bound the current turn to the active target, and only
  when the headers carry a quota dimension. A model or credential switch inside
  a turn discards passive attribution until the next turn; a fresh endpoint
  snapshot always wins over passive headers. A passive measurement stays bound
  to the logical model whose inference response produced it: another model of
  the same provider and credential route still shares the account-level
  endpoint cache and its retry gate, but never inherits that measurement.
- A model switch cancels in-flight work, detaches the cancelled request so a
  replacement starts fresh, clears the previous provider's snapshot, and marks
  the result generation so a late answer cannot paint the new provider. A
  cancelled run never writes its snapshot or retry deadline into the cache a
  replacement refresh now owns.
- Shutdown (quit, reload, session replacement) aborts requests, clears the
  timer, removes the footer entry, and is idempotent.
- Background refresh never runs outside TUI mode.

## Development

```sh
npm install          # devDependencies only (host packages are peer deps)
npm test             # node --test, sanitized fixtures, no network
npm run typecheck    # tsc --noEmit
npm run check        # typecheck + tests
npm run pack:dry-run # npm pack --dry-run
npm run load-check   # load the extension with the installed Pi runtime, no session
npm run live-smoke   # opt-in, GET-only, uses your real Pi providers
```

Live smoke examples:

```sh
npm run live-smoke                                   # openai, deepseek, cpa
npm run live-smoke -- --provider deepseek            # one provider (unresolvable = failure)
npm run live-smoke -- --provider openai --json       # sanitized JSON
```

The live smoke uses the installed Pi package (`PI_PACKAGE_DIR` or
`PI_UNIVERSAL_USAGE_PI_PACKAGE`, falling back to a resolved
`@earendil-works/pi-coding-agent`), and loads the same settings, credentials,
models, packages, and configured extensions through the public SDK service
factory (`createAgentSessionServices`). No session starts and no inference runs.
It performs one bounded GET sequence per provider and prints only provider id,
status, scheme, endpoint path, and metric kinds/scalars. Any extension-loading or
provider-registration error reported by the SDK stops the run with a sanitized
category before provider validation, so a surviving built-in provider is never
reported as validation of a failed configured replacement. Every requested
provider is required: a provider with no registered model (for example a missing
CPA extension), no usable credential, or no recognized quota answer fails the
run.

## Known limitations

- No quota interface is claimed for providers without one. OpenAI API-key and
  Anthropic API-key credentials expose no subscription endpoint; only passive
  response headers are shown.
- Pi's native `openai` OAuth token is API-audience, not a legacy ChatGPT/WHAM
  credential. The official `api.openai.com` origin is reported as unsupported
  with passive headers only; legacy ChatGPT usage is covered by
  `openai-codex`. A custom-origin `openai` registration uses same-origin
  discovery.
- Anthropic per-model windows are shown under the key name the payload uses;
  no duration is invented for them.
- Z.ai reset times are read as epoch milliseconds only, matching its published
  contract; other numeric magnitudes are treated as malformed rather than
  reinterpreted.
- Discovery is bounded and same-origin. An exotic proxy with a different usage
  path needs `providers.<id>.path`.
- Live validation of a third-party provider extension (for example CPA) uses the
  extension registration the SDK loader sees. If that proxy does not serve one
  of the documented quota paths, the smoke reports the failure; pin the path with
  `providers.<id>.path` when the proxy exposes a different one.

## Sources and provenance

The implementation is independently written from public wire contracts. The
following projects were consulted as references for those contracts (their code
is not copied, but their documentation of endpoint shapes informed the parsers
and endpoint table):

- `pi-usage` by mtrojnar (MIT) — Codex/WHAM, Anthropic, Kimi, OpenRouter shapes.
- `@singh-gur/pi-usage` (MIT) — Kimi and Z.ai shapes, endpoint paths.
- `pi-myusage` (MIT) — OpenRouter key/credits and Codex JSON shapes.
- `imdlan` usage extension (Apache-2.0) — DeepSeek `/user/balance` shape.
- `CLIProxyAPI` quota status handler (`cliProxyApiQuota`, Go) — weekly-only
  Codex status body, `quota_mode`, and `status_unavailable`.

## License

MIT. See [LICENSE](LICENSE).
