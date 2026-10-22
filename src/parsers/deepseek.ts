/**
 * DeepSeek balance JSON (`GET /user/balance`).
 *
 * Wire contract: `is_available` boolean and `balance_infos` entries with
 * `currency`, `total_balance`, `granted_balance`, `topped_up_balance` as decimal
 * strings. Each currency is a separate balance; zero is a real balance, and a
 * negative amount is preserved rather than clamped.
 */

import { arrayValue, booleanValue, decimalValue, objectValue, stringValue } from "../json.ts";
import type { ParseInput, ParseResult, UsageMetric, UsageParser } from "../types.ts";

export const deepseekBalanceParser: UsageParser = {
  id: "deepseek-balance",
  format: "json",

  detect(input: ParseInput): boolean {
    const root = objectValue(input.json);
    if (root === undefined) return false;
    return arrayValue(root.balance_infos) !== undefined || booleanValue(root.is_available) !== undefined;
  },

  parse(input: ParseInput): ParseResult | undefined {
    const root = objectValue(input.json);
    if (root === undefined) return undefined;
    const metrics: UsageMetric[] = [];
    const notices: string[] = [];

    const available = booleanValue(root.is_available);
    if (available === false) {
      metrics.push({
        id: "deepseek.availability",
        kind: "status",
        label: "balance availability",
        scope: "account",
        status: "unavailable",
        source: "deepseek-balance",
      });
    }

    for (const entry of arrayValue(root.balance_infos) ?? []) {
      const info = objectValue(entry);
      if (info === undefined) {
        notices.push("a balance entry is not an object");
        continue;
      }
      const currency = stringValue(info.currency);
      const total = decimalValue(info.total_balance);
      if (currency === undefined || total === undefined) {
        notices.push("a balance entry has no usable currency/total_balance");
        continue;
      }
      const granted = decimalValue(info.granted_balance);
      const toppedUp = decimalValue(info.topped_up_balance);
      const metric: UsageMetric = {
        id: `deepseek.balance.${currency.toLowerCase()}`,
        kind: "balance",
        label: `balance (${currency})`,
        scope: "account",
        remaining: total,
        unit: currency,
        source: "deepseek-balance",
      };
      const breakdown = [];
      if (granted !== undefined) breakdown.push({ label: "granted", value: granted });
      if (toppedUp !== undefined) breakdown.push({ label: "topped up", value: toppedUp });
      if (breakdown.length > 0) metric.breakdown = breakdown;
      metrics.push(metric);
    }

    if (metrics.length === 0) return undefined;
    return {
      scheme: "deepseek-balance",
      metrics,
      ...(notices.length > 0 ? { notice: notices.join("; ") } : {}),
    };
  },
};
