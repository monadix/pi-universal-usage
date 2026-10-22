/**
 * Resolve the installed Pi package (`@earendil-works/pi-coding-agent`) so the
 * scripts can use the same runtime, credentials, and providers as the CLI
 * without adding a runtime dependency to the extension.
 *
 * Explicit roots are honored first. Without one, the package entry is resolved
 * through Node, then its directory is walked up to the package root: the
 * package's `exports` map intentionally hides `package.json`, so resolving
 * `package.json` directly is not a portable fallback.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PiModuleSource {
  root: string;
  source: "env PI_UNIVERSAL_USAGE_PI_PACKAGE" | "env PI_PACKAGE_DIR" | "resolved package";
}

export function isPiRoot(path: string): boolean {
  try {
    const require = createRequire(pathToFileURL(join(path, "package.json")).href);
    const manifest = require(join(path, "package.json")) as { name?: string };
    return manifest.name === "@earendil-works/pi-coding-agent";
  } catch {
    return false;
  }
}

/** Walk up from a resolved module file to the directory whose manifest names Pi. */
function packageRootOfEntry(entry: string): string | undefined {
  let directory = dirname(entry);
  for (;;) {
    if (isPiRoot(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function locatePiPackage(): PiModuleSource | undefined {
  const override = process.env.PI_UNIVERSAL_USAGE_PI_PACKAGE;
  if (override !== undefined && isPiRoot(override)) {
    return { root: override, source: "env PI_UNIVERSAL_USAGE_PI_PACKAGE" };
  }
  const packageDir = process.env.PI_PACKAGE_DIR;
  if (packageDir !== undefined && isPiRoot(packageDir)) {
    return { root: packageDir, source: "env PI_PACKAGE_DIR" };
  }
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  } catch {
    return undefined;
  }
  const root = packageRootOfEntry(entry);
  return root === undefined ? undefined : { root, source: "resolved package" };
}

export async function loadPiModule(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  const located = locatePiPackage();
  if (located === undefined) {
    throw new Error(
      "Could not locate the installed Pi package. Set PI_UNIVERSAL_USAGE_PI_PACKAGE to the package root.",
    );
  }
  return (await import(pathToFileURL(join(located.root, "dist", "index.js")).href)) as typeof import("@earendil-works/pi-coding-agent");
}
