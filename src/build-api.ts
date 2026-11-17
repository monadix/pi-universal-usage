/**
 * Repository build helper for the public API artifact, not part of the API.
 *
 * `pi-universal-usage/api` must stay importable in plain Node from inside
 * `node_modules`, where Node refuses to strip TypeScript. The artifact is
 * therefore emitted by npm's install/package lifecycle (`prepare`) as well as by
 * the local checks. Pi installs Git packages with `npm install --omit=dev`
 * before running `prepare`, so the build cannot depend on the TypeScript
 * compiler; Node's built-in type stripping emits the same module graph instead.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Relative import/export specifiers keep their explicit `.ts` extension here. */
const relativeSpecifier = /(["'])(\.\.?\/[^"']+)\.ts\1/gu;

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = join(dirname(sourceRoot), "dist");

const pending = [join(sourceRoot, "api.ts")];
const emitted = new Set<string>();
const outputs = new Set<string>();
while (pending.length > 0) {
  const file = pending.pop()!;
  if (emitted.has(file)) continue;
  emitted.add(file);
  const code = readFileSync(file, "utf8");
  for (const specifier of code.matchAll(relativeSpecifier)) {
    pending.push(resolve(dirname(file), `${specifier[2]!}.ts`));
  }
  const output = join(outputRoot, relative(sourceRoot, file).replace(/\.ts$/u, ".js"));
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, stripTypeScriptTypes(code, { mode: "transform" }).replace(relativeSpecifier, "$1$2.js$1"));
  // Replace atomically: the checks and `npm pack` can rebuild while tests (or a
  // publish step) import the artifact emitted by a previous build.
  renameSync(temporary, output);
  outputs.add(output);
}

// Drop artifacts of modules that no longer exist, but only after the module
// graph is written: tests and `npm pack` can run while the previous artifact is
// still being imported.
for (const entry of readdirSync(outputRoot, { recursive: true, withFileTypes: true })) {
  const path = join(entry.parentPath, entry.name);
  if (entry.isFile() && !outputs.has(path)) rmSync(path, { force: true });
}

console.log(`built ${outputs.size} modules for pi-universal-usage/api into dist/`);
