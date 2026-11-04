# pi-universal-usage

A read-only usage monitor for the [Pi coding agent](https://pi.dev). See your
active provider's subscription usage, request/token budgets, or account balance
in the footer, and run `/usage` for a detailed report.

- Supports ChatGPT/Codex, Anthropic subscriptions, DeepSeek, OpenRouter, Kimi
  Coding, Z.ai, and compatible proxies.
- Uses the credentials Pi already resolves; no separate login or secrets file.
- Reports missing data as unknown, not as zero usage.

## Install

```sh
pi install git:github.com/monadix/pi-universal-usage
```

Requires Node.js 22.19 or newer and a compatible Pi runtime. To try a local
checkout for one invocation:

```sh
pi -e /absolute/path/to/pi-universal-usage
```

## Use

The footer shows a compact summary for the active provider, for example:

```text
cpa: weekly 42% · reset 2d 3h
deepseek: USD $8.82
```

Run:

```text
/usage
/usage deepseek
/usage deepseek cpa
```

With no arguments, `/usage` refreshes the active provider and enabled providers
listed in your configuration. Arguments select providers to refresh instead of
that default list; the report can also include the active provider's last
measurement. Disabled non-active providers are skipped.

The detailed report shows freshness, usage or balance, reset times, source,
and any errors or provider notices. A requested provider with no registered
model is listed as unknown rather than silently omitted.

In the TUI, `/usage` opens a scrollable view: use Up/Down, Page Up/Down, Home
or End to navigate, `r` to refresh, and Esc to close. Reset countdowns update
without making new requests. In print mode the report is printed as text; in
JSON mode it is recorded as a session entry rather than printed as text. RPC
clients with UI support receive a report widget and notification; without UI,
the report is recorded as a session entry.

### Reading the results

- Usage percentages describe the provider's reported consumption. Values above
  100% remain visible in the detailed report; compact percentages cap at 100%.
- A reset time in the past is shown as `reset elapsed`, not assumed replenished.
- Measurements older than twice the refresh interval are marked `stale`.
- Codex windows are labeled by their declared duration; an unspecified duration
  stays `primary` or `secondary`, rather than being guessed.
- Request/token rate limits, subscription quotas, key budgets, and balances are
  distinct measurements—not interchangeable estimates.
- When no quota endpoint is available, supported response headers can supply the
  last measurement for the same model. `/usage` retains its original timestamp.

Automatic refresh runs only in TUI mode: at startup and model selection, after
agent activity when throttling permits, and on a timer (five minutes by default).
Use `/usage` to request a refresh manually. Concurrent reads for the same account
share an in-flight request.

## Supported providers

| Provider | What can be shown |
|---|---|
| `openai-codex` | ChatGPT subscription windows and optional credits |
| `anthropic` with OAuth/subscription credentials | Subscription and per-model windows |
| `deepseek` | Account balance by currency |
| `openrouter` | Key budget or spend, plus optional account credits |
| Kimi Coding | Plan usage and quota windows, including durationless buckets |
| Z.ai | Token, credit, and time-limit quotas |
| Compatible custom providers/proxies, including CPA | Recognized usage formats through same-origin endpoint discovery |

The official `openai` API origin is not a ChatGPT subscription usage endpoint.
Use `openai-codex` for that subscription. OpenAI and Anthropic API-key usage
can be shown from supported response headers, but no subscription endpoint is
queried for those credentials.

See [Compatibility](docs/compatibility.md) for scheme IDs, wire formats,
official endpoints, and custom-provider authentication rules.

## Configuration

No configuration is required for supported first-party providers. Optional
settings go in `~/.pi/agent/pi-universal-usage.json`, or under
`PI_CODING_AGENT_DIR` when you use a custom agent directory. Project-local
configuration is deliberately ignored.

Every field is optional; this example shows the global defaults and adds
DeepSeek to the default report:

```json
{
  "refreshSeconds": 300,
  "minRefreshSeconds": 60,
  "timeoutMs": 8000,
  "maxBodyBytes": 262144,
  "maxDiscoveryRequests": 4,
  "reportConcurrency": 3,
  "autoRefresh": true,
  "warnings": true,
  "warningThresholds": [90, 100],
  "providers": {
    "deepseek": { "enabled": true }
  }
}
```

| Setting | Purpose |
|---|---|
| `refreshSeconds` | Background timer interval and successful-result cache lifetime |
| `minRefreshSeconds` | Minimum interval between activity-triggered refresh attempts; the timer also respects this minimum |
| `timeoutMs` | Timeout for each HTTP request |
| `maxBodyBytes` | Maximum response body size |
| `maxDiscoveryRequests` | Maximum endpoint candidates tried for a custom provider |
| `reportConcurrency` | Maximum provider refreshes per report (integer 1–8, default 3); all selected providers are included |
| `autoRefresh` | Set to `false` for manual endpoint refresh only; response-header measurements can still update |
| `warnings` | Set to `false` to disable subscription-window notifications (default `true`) |
| `warningThresholds` | Non-empty array of finite consumed percentages greater than 0 and at most 100 (default `[90, 100]`); invalid values fall back to the default with a configuration problem |
| `providers` | Provider IDs to include in the default report, with optional overrides |

Warnings are emitted once per threshold, account, normalized metric dimension,
and known future reset window, including an initial measurement already above a
threshold. Stale or unknown windows, elapsed resets, and non-subscription limits
do not trigger warnings. Notifications
require a Pi UI (TUI or a supporting RPC client); they are not printed in non-UI modes.
Invalid `warnings` values fall back to `true` with a configuration problem.

Per-provider options are `enabled` (default `true`), `scheme` (default
`auto`), `path`, and `pathMode` (default `base`). A disabled provider makes
no quota requests and produces no passive-header updates.

An explicit path must stay on the credential's origin. Use `pathMode: "base"`
to append it to the resolved base path, or `"origin"` to start at the origin
root. For example, pin a CPA endpoint without discovery:

```json
{
  "providers": {
    "cpa": {
      "path": "/backend-api/wham/usage",
      "pathMode": "origin"
    }
  }
}
```

Leave `scheme` at `auto` unless you need strict format selection. Invalid
provider settings are ignored or fall back to defaults, with configuration
problems shown in the report. Reload the extension after changing the file.

## Troubleshooting and limitations

- **Unsupported or no quota data:** check the credential type and provider table.
  A custom proxy may need an explicit `path`; discovery is bounded and cannot
  find every endpoint.
- **Old or unavailable data:** errors trigger retry backoff: normally one minute
  for transient failures, five minutes for rate limits/unavailability, and
  thirty minutes for rejected credentials or unsupported endpoints.
  `Retry-After` is honored up to one hour. `/usage` bypasses the main backoff;
  optional endpoints can retain their own retry deadline.
- **No footer in non-TUI use:** background refresh and the footer are TUI
  features; use `/usage` for a report.
- **Command conflict:** if another extension registers `/usage`, disable one.
- **No report after switching models:** reports that span a selection change
  are discarded to avoid showing data under the wrong selection.
- **Header measurements differ from endpoint data:** generic request/token
  limits are distinct from subscription quotas and balances. A fresh endpoint
  quota or balance remains in the footer alongside generic limits; a provider
  rejection such as HTTP 429 takes precedence. Other header measurements can
  replace the footer until the next refresh.
- **Routing changes:** credentials and base URLs are re-resolved on refresh.
  A routing-header-only change without a selection event can leave the old
  footer visible until the next refresh.

## Privacy and request safety

The monitor makes GET requests only—no inference calls, model probes, browser
scraping, or management credentials. Custom credentials stay on their resolved
origin; redirects and URLs containing userinfo are refused. Requests have time
and body-size limits.

Configuration contains no secrets. Reports omit credentials and sanitize remote
text before displaying it. Loading the extension registers handlers without
starting network requests; usage reads begin through session activity or
`/usage`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for offline checks, package inspection,
and opt-in live provider tests.

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
