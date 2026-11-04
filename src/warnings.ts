import type { UsageConfig } from "./config.ts";
import { plainText } from "./text.ts";
import type { TargetSnapshot } from "./types.ts";

/** Session-local, secret-free threshold deduplication for known quota windows. */
export class UsageWarnings {
  private readonly seen = new Map<string, { reset: number; thresholds: Set<number> }>();

  observe(snapshot: TargetSnapshot, config: UsageConfig, now: number): string[] {
    if (!config.warnings || snapshot.status !== "ok" || !Number.isFinite(snapshot.fetchedAt) ||
      now - snapshot.fetchedAt > config.refreshSeconds * 2000 || snapshot.fetchedAt > now) return [];
    for (const [key, entry] of this.seen) if (entry.reset * 1000 <= now) this.seen.delete(key);
    const messages: string[] = [];
    for (const metric of snapshot.metrics) {
      const reset = metric.resetAtSeconds;
      const used = metric.usedPercent;
      if (metric.kind !== "subscription-window" || metric.source === "rate-limit-headers" ||
        reset === undefined || !Number.isFinite(reset) || reset * 1000 <= now ||
        used === undefined || !Number.isFinite(used) || used < 0) continue;
      // Anthropic's JSON and unified headers name the same plan windows differently.
      const dimension = metric.source === "anthropic-headers" && metric.id === "anthropic.5h" ? "anthropic.five_hour"
        : metric.source === "anthropic-headers" && metric.id === "anthropic.7d" ? "anthropic.seven_day"
        : metric.id;
      const key = JSON.stringify([snapshot.identity.key, dimension, metric.scope ?? "", reset]);
      let entry = this.seen.get(key);
      for (const threshold of config.warningThresholds) {
        if (used < threshold || entry?.thresholds.has(threshold)) continue;
        if (entry === undefined) {
          entry = { reset, thresholds: new Set() };
          this.seen.set(key, entry);
        }
        entry.thresholds.add(threshold);
        messages.push(plainText(`pi-universal-usage: ${snapshot.identity.providerId} ${metric.label} has reached ${threshold}% consumed`));
      }
    }
    return messages;
  }

  clear(): void {
    this.seen.clear();
  }
}
