/**
 * Extension-registration check against the installed Pi runtime, without a
 * session and without any provider request.
 *
 * Usage: npm run load-check
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPiModule, locatePiPackage } from "./pi-module.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensionEntry = join(here, "..", "extensions", "index.ts");

const located = locatePiPackage();
if (located === undefined) {
  console.error("load-check: could not locate the installed Pi package");
  process.exit(1);
}

const pi = await loadPiModule();
const result = await pi.discoverAndLoadExtensions([extensionEntry], join(here, ".."));

const failures = result.errors.filter((error) => error.path.includes("pi-universal-usage") || error.path.includes(extensionEntry));
const loaded = result.extensions.filter((extension) => extension.resolvedPath === extensionEntry || extension.path === extensionEntry);

if (failures.length > 0) {
  for (const failure of failures) console.error(`load-check: extension error in ${failure.path}: ${failure.error}`);
  process.exit(1);
}
if (loaded.length === 0) {
  console.error("load-check: the extension entry was not loaded");
  process.exit(1);
}

const extension = loaded[0];
const command = extension.commands.get("usage");
const events = [...extension.handlers.keys()].sort();
console.log(`loaded from ${located.source}`);
console.log(`command: ${command?.name ?? "(missing)"}`);
console.log(`events: ${events.join(", ")}`);
if (command === undefined) process.exit(1);
