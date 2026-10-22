/**
 * Parser registry. Schemes are registered once and resolved by name, so adding
 * a wire format never touches provider-specific UI code.
 */

import { anthropicHeadersParser, anthropicJsonParser } from "./parsers/anthropic.ts";
import { codexHeadersParser } from "./parsers/codex-headers.ts";
import { codexJsonParser } from "./parsers/codex-json.ts";
import { deepseekBalanceParser } from "./parsers/deepseek.ts";
import { kimiJsonParser } from "./parsers/kimi.ts";
import { openrouterJsonParser } from "./parsers/openrouter.ts";
import { rateLimitHeadersParser } from "./parsers/rate-limit-headers.ts";
import { zaiJsonParser } from "./parsers/zai.ts";
import type { ParseInput, ParseResult, SchemeId, UsageParser } from "./types.ts";

const JSON_PARSERS: readonly UsageParser[] = [
  codexJsonParser,
  anthropicJsonParser,
  openrouterJsonParser,
  deepseekBalanceParser,
  kimiJsonParser,
  zaiJsonParser,
];

const HEADER_PARSERS: readonly UsageParser[] = [codexHeadersParser, anthropicHeadersParser, rateLimitHeadersParser];

export const SCHEME_IDS: readonly SchemeId[] = [
  ...JSON_PARSERS.map((parser) => parser.id),
  ...HEADER_PARSERS.map((parser) => parser.id),
];

export function isSchemeId(value: unknown): value is SchemeId {
  return typeof value === "string" && (SCHEME_IDS as readonly string[]).includes(value);
}

export function schemeIsHeadersOnly(scheme: SchemeId): boolean {
  return HEADER_PARSERS.some((parser) => parser.id === scheme);
}

/**
 * Parse a JSON body with the named scheme, or with every registered JSON scheme
 * when no scheme is named. Auto-detection requires the scheme's structural
 * signature; the first scheme that yields usable measurements wins.
 */
export function parseJsonPayload(input: ParseInput, scheme?: SchemeId): ParseResult | undefined {
  if (scheme !== undefined) {
    const parser = JSON_PARSERS.find((candidate) => candidate.id === scheme);
    if (parser === undefined) return undefined;
    return parser.detect(input) ? parser.parse(input) : undefined;
  }
  for (const parser of JSON_PARSERS) {
    if (!parser.detect(input)) continue;
    const result = parser.parse(input);
    if (result !== undefined && result.metrics.length > 0) return result;
  }
  return undefined;
}

/**
 * Parse response headers. Independent header dimensions may coexist, so every
 * matching header scheme contributes its own metrics.
 */
export function parseHeaderPayload(headers: Record<string, string>, status: number, now: number): ParseResult[] {
  const input: ParseInput = { headers, status, now };
  const results: ParseResult[] = [];
  for (const parser of HEADER_PARSERS) {
    if (!parser.detect(input)) continue;
    const result = parser.parse(input);
    // An explicit rejection without window metrics is still a measurement of
    // the response status, so it must reach the monitor.
    if (result !== undefined && (result.metrics.length > 0 || result.rateLimited === true)) results.push(result);
  }
  return results;
}
