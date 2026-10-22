/**
 * Pi extension entry point for pi-universal-usage.
 *
 * Load with `pi -e /absolute/path/to/pi-universal-usage` or install the package.
 * The factory only registers handlers; credential resolution and network reads
 * start at session start, a model change, a turn end, or `/usage`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUsageExtension } from "../src/extension.ts";

export default function piUniversalUsage(pi: ExtensionAPI): void {
  createUsageExtension(pi);
}
