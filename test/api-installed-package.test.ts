import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("serves the public API to an installed plain-Node consumer without a loader or Pi bootstrap", { timeout: 90_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "usage-api-consumer-"));
  try {
    const artifacts = join(root, "artifacts");
    const consumer = join(root, "consumer");
    const home = join(root, "home");
    const agentDir = join(home, "agent");
    for (const dir of [artifacts, consumer, agentDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "usage-api-consumer", private: true, type: "module" }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir };
    // Neither inherited loader flags nor repository module paths may make the
    // installed consumer work when an ordinary plain-Node import would fail.
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const npmCli = process.env.npm_execpath;
    const npmCommand = npmCli === undefined ? "npm" : process.execPath;
    const npmPrefix = npmCli === undefined ? [] : [npmCli];
    const npm = (args: string[], cwd: string) => {
      const child = spawnSync(npmCommand, [...npmPrefix, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
      assert.ifError(child.error);
      assert.equal(child.status, 0, `${args[0]} failed:\n${child.stdout}\n${child.stderr}`);
    };
    // Exercise the distributable, including its publication lifecycle, rather
    // than copying a guessed list of source/build files or using a symlink.
    npm(["pack", "--offline", "--pack-destination", artifacts], fileURLToPath(new URL("..", import.meta.url)));
    const archives = readdirSync(artifacts).filter((name) => name.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    // Pi supplies peer packages; this headless consumer supplies a fake registry
    // instead. Keep installation offline and do not run consumer install hooks.
    npm(["install", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--package-lock=false",
      join(artifacts, archives[0]!)], consumer);
    const installed = join(consumer, "node_modules", "pi-universal-usage");
    assert.equal(lstatSync(installed).isSymbolicLink(), false);
    assert.equal(realpathSync(installed), join(realpathSync(consumer), "node_modules", "pi-universal-usage"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { realpathSync } from 'node:fs';
      import { join, sep } from 'node:path';
      import { fileURLToPath } from 'node:url';
      import { syncBuiltinESMExports } from 'node:module';
      import http from 'node:http';
      import https from 'node:https';
      import net from 'node:net';
      import tls from 'node:tls';
      const installed = realpathSync(join(process.cwd(), 'node_modules', 'pi-universal-usage'));
      const resolved = realpathSync(fileURLToPath(import.meta.resolve('pi-universal-usage/api')));
      assert.ok(resolved.startsWith(installed + sep), 'API must resolve inside the installed package');
      let sideEffects = 0, authCalls = 0, quotaCalls = 0;
      const forbidden = () => { sideEffects++; throw new Error('unexpected API side effect'); };
      // Block actual networking, including accidental SDK bootstrap requests.
      globalThis.fetch = forbidden;
      http.request = http.get = https.request = https.get = forbidden;
      net.connect = net.createConnection = tls.connect = forbidden;
      syncBuiltinESMExports();
      const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
      const stdout = process.stdout.write, stderr = process.stderr.write;
      globalThis.setTimeout = globalThis.setInterval = forbidden;
      process.stdout.write = process.stderr.write = forbidden;
      let client;
      try {
        const { createUsageClient, formatUsageReport } = await import('pi-universal-usage/api');
        const model = { provider: 'deepseek', id: 'chat', api: 'openai-responses', baseUrl: 'https://api.deepseek.com' };
        const registry = {
          getAll: () => [model], getAvailable: () => [model],
          getApiKeyAndHeaders: async () => { authCalls++; return { ok: true, apiKey: 'SYNTHETIC_INSTALLED_KEY' }; },
          getProviderAuthStatus: () => ({ configured: true, source: 'stored' }), isUsingOAuth: () => false,
        };
        client = createUsageClient({ modelRegistry: registry, getActiveModel: () => model, now: () => 1768000000000,
          fetchImpl: async (_input, init) => {
            quotaCalls++;
            assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
            return new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '7' }] }),
              { headers: { 'content-type': 'application/json' } });
          } });
        assert.equal(authCalls, 0); assert.equal(quotaCalls, 0);
        assert.deepEqual(client.listProviders(), [{ provider: 'deepseek', enabled: true, active: true }]);
        assert.equal(authCalls, 0);
        const cold = await client.read({ refresh: 'cached' });
        assert.equal(cold.results[0].freshness, 'missing'); assert.equal(quotaCalls, 0);
        assert.equal(sideEffects, 0);
        // HTTP deadlines are allowed for an explicit read, not at import,
        // construction, enumeration, or a cache-only read.
        globalThis.setTimeout = timeout; globalThis.setInterval = interval;
        const report = await client.read();
        assert.equal(report.schemaVersion, 1); assert.equal(report.generatedAt, 1768000000000);
        assert.equal(report.results.length, 1); assert.equal(report.results[0].status, 'ok');
        assert.equal(report.results[0].freshness, 'fresh'); assert.equal(report.results[0].source, 'http');
        assert.equal(report.results[0].observedAt, 1768000000000);
        assert.equal(report.results[0].metrics[0].remaining, 7); assert.equal(quotaCalls, 1);
        const text = formatUsageReport(report);
        assert.match(text, /deepseek/); assert.match(text, /7/);
        assert.doesNotMatch(JSON.stringify(report) + text, /SYNTHETIC_INSTALLED_KEY/);
        assert.equal(sideEffects, 0);
      } finally {
        globalThis.setTimeout = timeout; globalThis.setInterval = interval;
        process.stdout.write = stdout; process.stderr.write = stderr;
        client?.dispose();
      }
    `], { cwd: consumer, env, encoding: "utf8", timeout: 10_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
    assert.deepEqual(readdirSync(agentDir), [], "API must not create Pi service/session state");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
