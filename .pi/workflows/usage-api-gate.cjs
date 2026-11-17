// Host-only post-child validation and iteration commit; never invoked by the implementer.
const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const phase = process.argv[2];
const iteration = process.argv[3];
if (!['spec', 'implementation', 'regression'].includes(phase) || !/^\d+$/.test(iteration || '')) {
  throw new Error('Expected phase and numeric iteration');
}
function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function git(...args) {
  const result = command('git', args);
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
if (git('branch', '--show-current') !== 'feat/usage-api-agent-tools') throw new Error('Wrong branch');
if (git('diff', '--cached', '--name-only')) throw new Error('Unexpected staged changes');
const files = [...new Set([
  ...git('diff', '--name-only').split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').split('\n'),
].filter(Boolean))];
for (const file of files) {
  const permitted = phase === 'implementation'
    ? /^(src\/|extensions\/|docs\/(?!api-specification\.md$)|README\.md$|package(?:-lock)?\.json$|tsconfig\.json$)/.test(file)
    : /^(test\/|docs\/api-specification\.md$)/.test(file);
  if (!permitted) throw new Error(`Out-of-scope ${phase} edit: ${file}`);
}
if (!files.length) throw new Error(`No edits in ${phase} iteration ${iteration}; checkpoint required`);
const logDir = join(tmpdir(), 'pi-usage-api-evidence', git('rev-parse', '--short', 'HEAD') + '-' + phase + '-' + iteration + '-' + Date.now());
mkdirSync(logDir, { recursive: true });
const checks = [];
for (const script of ['check', 'pack:dry-run', 'load-check']) {
  const result = command('npm', ['run', script]);
  const log = join(logDir, script.replaceAll(':', '-') + '.log');
  writeFileSync(log, result.stdout + result.stderr);
  checks.push({ command: `npm run ${script}`, exitCode: result.status, log,
    summary: (result.stdout + result.stderr).slice(-4500) });
}
const message = phase === 'implementation'
  ? `feat: implement usage API and tools iteration ${iteration}`
  : phase === 'spec'
    ? 'test: specify usage API and agent tool contracts'
    : `test: cover usage API review findings iteration ${iteration}`;
git('add', '--', ...files);
git('commit', '-m', message);
const report = { phase, iteration: Number(iteration), commit: git('rev-parse', 'HEAD'),
  testsPassed: checks.every(check => check.exitCode === 0), checks };
writeFileSync(join(logDir, 'result.json'), JSON.stringify(report, null, 2));
// Keep typed output bounded; complete diagnostics remain in the referenced logs.
console.log(JSON.stringify({ ...report, checks: checks.map(check => ({ ...check, summary: check.summary.slice(-2200) })) }));
