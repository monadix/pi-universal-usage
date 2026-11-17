// Launch with subagent({ workflow: './.pi/workflows/usage-api.js', async: true, cwd: <repo> }).
// One writer at a time. Only host-run gates execute checks and commit iterations.
const cwd = args.cwd || '/home/monadix/FH/pi/pi-universal-usage';
const base = '61df39c';
const specPath = 'docs/api-specification.md';
const common = `Repository: ${cwd}. Branch: feat/usage-api-agent-tools; base: ${base}.
Read applicable instructions, README.md, CONTRIBUTING.md and relevant existing code/tests first.
All current changes/commits on this feature branch are authorized work for this task.
Do not stage, commit, switch branches, spawn agents or run tests/checks yourself.
A host gate runs npm run check, npm run pack:dry-run and npm run load-check AFTER your turn ends, then commits that iteration (including failing iterations).
If blocked or unable to complete, contact the supervisor and stop; do not claim success or silently redefine scope.
Use early progress checkpoints and stop with a precise handoff before context exhaustion.
`;
const contract = `Implement the approved design, not additional features:
- Stable public import pi-universal-usage/api, usable by Node >=22.19 scripts without starting a Pi session, implicit runtime bootstrapping, timers or networking on import/construction.
- createUsageClient({modelRegistry, getActiveModel?, config?}); reuse Pi credential resolution, config, endpoint safety, bounded HTTP and monitor semantics. Injectable clock/fetch seams may be specified for deterministic tests.
- UsageClient: synchronous listProviders(), async read({selection?, refresh?, signal?}), dispose(). Selection is exactly one of {active:true}, {providers:readonly string[]}, {models:readonly {provider,modelId}[]}; default active. Reject invalid/empty selections and active selection without a resolver/model; do not expose arbitrary URLs, auth, credentials, endpoint overrides or unrestricted concurrency.
- refresh cached|if-needed|force, default if-needed. cached performs no quota HTTP and reports missing measurements. if-needed refreshes absent/expired results respecting backoff. force mirrors explicit /usage while preserving optional-endpoint retry deadlines. Disabled providers never make quota requests or passive updates; return explicit disabled results. Concurrent callers share account-scoped work. Cancelling one caller cancels only its wait, never another caller's shared request. Disposal is idempotent and ends owned work. Selection is bound at read start; do not silently substitute a newly selected model. Re-resolve credentials/routes as needed to prevent cross-account cache reuse.
- UsageReport {schemaVersion:1, generatedAt:Unix milliseconds, results:UsageResult[], configProblems:string[]}. UsageResult includes provider, optional modelId, existing TargetStatus plus disabled, metrics, freshness fresh|stale|missing, observedAt? Unix ms retaining ORIGINAL measurement time, source? http|headers, cacheHit:boolean, nextRetryAt?, notice?, error?:{code,message}. Unknown numeric fields omitted, never zero-filled. Keep resetAtSeconds and durationSeconds explicit. Measurement source is separate from cache delivery. Preserve normalized subscription/request/token/budget/balance/status dimensions, scopes where safe, above-100% measurements and elapsed resets without inventing data.
- Public DTO whitelist/sanitization: exclude internal target keys/fingerprints, credentials, account IDs, origins, raw payloads, headers and arbitrary exception text. Sanitize metric IDs/labels/scopes/components, notices, errors and config problems. Do not leak private values through tool text, details or structured output. Provider failures are per-result data; throw only invalid arguments, cancellation and client misuse. Provider enumeration is registered IDs/config/active selection, not a network-free assertion of endpoint/credential usability.
- Pure formatUsageReport(report) exported by the public API; reads never write stdout, append session entries, open UI or emit UI warnings.
- Two tools usage_providers({}) and usage_read({providers?:string[],refresh?:cached|if-needed|force}); omitted providers means active ONLY; explicit providers means only that selection, no implicit extra active provider; reject empty providers. Return structured report plus short text. Provider unavailability is data, not tool execution failure. Forward cancellation. Descriptions explain read-only authenticated bounded quota GETs, no inference/config changes. Prefer JSON Schema compatible with both installed Pi peer packages and current Pi; inspect actual APIs.
- Tools, /usage, footer/background updates and passive headers share one underlying client/cache/in-flight service within Pi; preserve current /usage selection/presentation, warning deduplication, stale-result protection, UI modes, disabled-provider and routing/credential safety semantics. New tool reads must not trigger presentation side effects.
- V1 scope: DTOs, headless service, tools, existing command integration and pure formatter. No subscriptions, config-writing tools, per-provider tools, arbitrary endpoints, standalone runtime loader or CLI. Keep code/docs proportional and avoid redundant abstractions.
`;
const docs = `For Pi-specific work inspect installed Pi SDK/types and docs. Main docs: /nix/store/nbksxnv9wk62h5pvds9nd96kcfai0m81-pi-coding-agent-1.5.0/lib/node_modules/pi-monorepo; relevant docs/extensions.md, docs/sdk.md, docs/packages.md and relevant examples/extensions, following relevant cross-references. Repository peer dev versions are 1.2.0, so do not assume the latest docs' runtime-only additions are required or present. Existing runtime load-check must remain passing.`;
let specification = await runs.run('specification', {
  label: 'Specify API and independent tests', agent: 'usage-spec-tests-sol', cwd,
  model: 'openai-codex/gpt-6.1-sol',
  task: common + contract + docs + `\nAuthor the durable, developer-facing specification at ${specPath} and deterministic behavioral tests under test/. Do not modify production files/package/workflow/agent definitions. This is the initial test-first pass: missing exports may fail until implemented. Specify precise defaults, unknown/disabled/unresolved statuses, freshness/cache/backoff, JSON serialization, duplicate selection and cancellation semantics, public type/import compatibility and tool result shapes. Tests must cover actual externally observable behavior rather than demand a particular class decomposition. Reuse test conventions and fixtures. Cover credential/routing changes, shared cancellation, passive header reuse, single-cache /usage integration, no UI/output side effects, schema validation, per-provider failures, concurrency limits, disposal and unknown != zero. Read the full baseline test helpers before authoring replacements/mocks. Report requirement-to-test mapping, any untested requirements and decisions; no executing tests or typecheck.`,
  output: 'reports/specification.md', timeoutMs: 3600000, checkpointBeforeDeadlineMs: 120000,
  gate: { command: 'node .pi/workflows/usage-api-gate.cjs spec 0', output: 'json', timeoutMs: 600000 },
});
if (!specification.ok || !specification.structuredOutput) return { status: 'blocked-specification', result: specification };
emit({ stage: 'specification', evidence: specification.structuredOutput });
let evidence = specification.structuredOutput;
let feedback = 'Implement the complete specification and satisfy the independently authored tests. Read ' + specPath + ' and all feature tests.';
let implementationPasses = 0;
let reviewPasses = 0;
const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['passed', 'findings', 'blocked'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: {
        category: { type: 'string', enum: ['quality', 'behavior'] },
        severity: { type: 'string' }, location: { type: 'string' },
        requirement: { type: 'string' }, trigger: { type: 'string' },
        impact: { type: 'string' }, recommendation: { type: 'string' },
        coveredByExistingTests: { type: 'boolean' },
        genericCoverageGap: { type: 'string' }, suggestedTests: { type: 'string' },
      }, required: ['category', 'severity', 'location', 'requirement', 'trigger', 'impact', 'recommendation', 'coveredByExistingTests', 'genericCoverageGap', 'suggestedTests'],
    } },
    limitations: { type: 'string' },
  }, required: ['status', 'summary', 'findings', 'limitations'],
};
// Bounds are checkpoint limits, not acceptance criteria; exhausting one never means completion.
while (implementationPasses < 16 && reviewPasses < 6) {
  implementationPasses++;
  const implemented = await runs.run('implementation-' + implementationPasses, {
    label: 'Edit implementation pass ' + implementationPasses,
    agent: 'usage-implementer-opencode', model: 'opencode-go/deepseek-v4.1-flash', cwd,
    task: common + docs + `\nRead ${specPath}; it is the contract. You are the ONLY production writer. Do not change tests/spec or orchestration. You MUST NOT execute tests, typechecking, validation, inline project code, installs or live requests. Make production edits only and finish; the host gate validates and commits afterwards.\nFeedback:\n${feedback}\nPrior host check results (read referenced full logs for diagnostics):\n${JSON.stringify(evidence)}\nInitial spec author's report:\n${specification.output}`,
    output: 'reports/implementation-' + implementationPasses + '.md',
    timeoutMs: 3600000, checkpointBeforeDeadlineMs: 120000,
    gate: { command: 'node .pi/workflows/usage-api-gate.cjs implementation ' + implementationPasses,
      output: 'json', timeoutMs: 600000 },
  });
  if (!implemented.ok || !implemented.structuredOutput) return { status: 'blocked-implementation', implementationPasses, result: implemented };
  evidence = implemented.structuredOutput;
  emit({ stage: 'implementation', pass: implementationPasses, evidence });
  if (!evidence.testsPassed) {
    feedback = 'The host-run repository checks failed. Read their full logs, fix the production defects, do not weaken or edit tests, and do not run checks yourself. Make a focused complete fix iteration. Escalate incorrect tests with evidence rather than editing them.';
    continue;
  }
  reviewPasses++;
  const reviewed = await runs.run('review-' + reviewPasses, {
    label: 'Review quality and correctness pass ' + reviewPasses,
    agent: 'reviewer-sol-codex', model: 'openai-codex/gpt-6.1-sol', cwd,
    task: common + `\nYou are a fresh READ-ONLY independent code-quality and correctness reviewer. Review the FINAL current implementation, all fixes included, using git diff ${base}...HEAD and read surrounding relevant code, ${specPath}, feature tests, package exports and workflow evidence. Do not edit/commit files or run checks; host results below are available.\nCheck approved API/tool contract, correct/maintainable minimal design, public script imports and installed Pi compatibility, credential/privacy/origin safety, caching and cancellation correctness, preserved /usage and UI behavior, real integration and performance risks. Check docs proportion and audience; flag misplaced internal mechanics or gratuitous abstractions. Do not report taste-only refactors.\nFor each actionable finding classify quality versus behavior. Quality defects go straight to implementer. Behavioral defects NOT caught by existing tests MUST explain the reusable/general reason for the coverage gap and propose specific behavior-focused test additions/corrections that fail on the current implementation. State coveredByExistingTests accurately. For quality entries use empty strings for irrelevant coverage fields. Never mark passed while findings remain or required review is incomplete; use blocked for an actual blocker.\nHost checks:\n${JSON.stringify(evidence)}\nReturn the required structured result, including comparison base and limitations.`,
    outputSchema: reviewSchema, output: 'reports/review-' + reviewPasses + '.json',
    timeoutMs: 2400000, checkpointBeforeDeadlineMs: 120000,
  });
  if (!reviewed.ok || !reviewed.structuredOutput) return { status: 'blocked-review', implementationPasses, reviewPasses, result: reviewed };
  const review = reviewed.structuredOutput;
  emit({ stage: 'review', pass: reviewPasses, result: review });
  if (review.status === 'blocked') return { status: 'blocked-review', review, evidence };
  if (review.status === 'passed' && review.findings.length === 0) {
    return { status: 'complete', implementationPasses, reviewPasses, finalEvidence: evidence,
      review: reviewed.outputReference, specification: specification.outputReference };
  }
  if (review.findings.length === 0) return { status: 'inconsistent-review-needs-supervisor', review, evidence };
  const uncovered = review.findings.filter(finding => finding.category === 'behavior' && !finding.coveredByExistingTests);
  if (uncovered.length) {
    const regressions = await runs.run('regression-tests-' + reviewPasses, {
      label: 'Add tests for uncovered behavior pass ' + reviewPasses,
      agent: 'usage-spec-tests-sol', model: 'openai-codex/gpt-6.1-sol', cwd,
      task: common + `\nRead ${specPath}, current production code and existing tests. Add/correct behavioral tests for the following confirmed review findings WITHOUT modifying production/workflow files or weakening coverage. Explain the generic reason the prior tests missed them; cover the invariant rather than implementation details. Keep the approved specification unchanged unless clarifying an existing requirement is genuinely necessary; escalate material changes. Do not execute tests. The gate runs checks and commits your test iteration before the implementer resumes.\nFindings:\n${JSON.stringify(uncovered)}\nFull review:\n${JSON.stringify(review)}`,
      output: 'reports/regression-tests-' + reviewPasses + '.md',
      timeoutMs: 2400000, checkpointBeforeDeadlineMs: 120000,
      gate: { command: 'node .pi/workflows/usage-api-gate.cjs regression ' + reviewPasses,
        output: 'json', timeoutMs: 600000 },
    });
    if (!regressions.ok || !regressions.structuredOutput) return { status: 'blocked-regression-tests', result: regressions, review };
    evidence = regressions.structuredOutput;
    emit({ stage: 'regression-tests', pass: reviewPasses, evidence });
    if (evidence.testsPassed) return { status: 'regression-tests-did-not-reproduce-needs-supervisor', review, evidence };
  }
  feedback = `Fix every actionable review finding, including quality defects directly and behavior defects covered by the new independent regression tests. Do not edit tests. A new independent review is required after all fixes and host checks pass.\n${JSON.stringify(review)}`;
}
return { status: 'checkpoint-limit-not-complete', implementationPasses, reviewPasses, evidence, feedback };
