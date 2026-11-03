# Contributing

## Local checks

Requires Node.js 22.19 or newer. Pi loads the TypeScript entry point directly;
there is no build step.

```sh
npm install
npm run check        # TypeScript checking and offline tests
npm run pack:dry-run # inspect the package contents
npm run load-check   # load with the installed Pi runtime, without a session
```

Tests use sanitized fixtures and injected credentials/fetch implementations; they
do not contact providers. Keep regression tests deterministic and preserve the
extension's read-only, credential-scoped request behavior.

## Live provider checks

Live smoke tests are opt-in and use your real Pi settings, credentials, models,
and configured provider extensions. They make bounded GET quota requests only;
no agent session starts and no inference runs.

```sh
npm run live-smoke -- --provider openai-codex
npm run live-smoke -- --provider deepseek --json
npm run live-smoke -- --provider openai-codex --provider cpa
```

Choose providers explicitly. Without arguments the script checks `openai`,
`deepseek`, and `cpa`; the official `openai` origin has no supported subscription
endpoint here, so it normally fails that check. Use `openai-codex` for ChatGPT
subscription usage.

The script resolves the installed `@earendil-works/pi-coding-agent` package;
`PI_PACKAGE_DIR` or `PI_UNIVERSAL_USAGE_PI_PACKAGE` can select its directory.
It loads runtime services through `createAgentSessionServices`, without starting
a session. Extension-loading or provider-registration errors fail the run.
Every selected provider must resolve and return a usable snapshot to pass.
Output is sanitized: it includes status, endpoint path, and metric values,
not credentials, account identifiers, or raw payloads.

A live quota read checks provider integration. Credential rotation and overlapping
refresh races need deterministic tests; a single-account smoke test does not
establish their correctness.
