import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { formatMetric, isDisplayableMetric, isUsableMetric, unavailableReason, unavailableText } from "./format.ts";
import { plainText } from "./text.ts";
import type { TargetSnapshot, UsageMetric } from "./types.ts";

/** One interaction: only an explicit refresh initiates collection. */
export class UsageView {
  private snapshots: TargetSnapshot[] | undefined;
  private loading = false;
  private closed = false;
  private sequence = 0;
  private offset = 0;
  private pageSize = 1;

  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly done: () => void;
  private readonly collect: () => Promise<TargetSnapshot[] | undefined>;
  private readonly now: () => number;
  private readonly unavailable: (message: string) => void;

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    done: () => void,
    collect: () => Promise<TargetSnapshot[] | undefined>,
    now: () => number,
    unavailable: (message: string) => void,
  ) {
    this.tui = tui;
    this.done = done;
    this.collect = collect;
    this.now = now;
    this.unavailable = unavailable;
  }

  refresh(): void {
    if (this.closed || this.loading) return;
    const sequence = ++this.sequence;
    this.loading = true;
    this.tui.requestRender();
    // Also handle a synchronous collection failure without exposing exception text.
    void Promise.resolve().then(() => this.closed ? undefined : this.collect()).then((snapshots) => {
      if (this.closed || sequence !== this.sequence) return;
      this.loading = false;
      // Undefined denotes cancellation or invalidation, not provider failure.
      if (snapshots === undefined) return this.close();
      if (!snapshots.some((snapshot) => snapshot.metrics.some(isUsableMetric))) {
        const reasons = [...new Set(snapshots.map(unavailableReason))].join("; ") || "no provider could be resolved";
        this.close();
        this.unavailable(truncateToWidth(`Usage unavailable: ${reasons}`, 72));
        return;
      }
      this.snapshots = snapshots;
      this.tui.requestRender();
    }, () => {
      if (this.closed || sequence !== this.sequence) return;
      this.close();
      this.unavailable("Usage unavailable: provider refresh failed");
    });
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const inner = Math.max(1, w - 4);
    const body: string[] = [];
    for (const snapshot of this.snapshots ?? []) {
      const metrics = snapshot.metrics.filter(isDisplayableMetric);
      if (metrics.length === 0) {
        body.push(unavailableText(snapshot));
        continue;
      }
      body.push(plainText(snapshot.identity.providerId));
      for (const metric of metrics) {
        const scope = metric.scope === undefined ? "" : ` [${metric.scope}]`;
        body.push(`  ${formatMetric(metric, this.now())}${plainText(scope)}`);
        if (metric.usedPercent !== undefined && metric.usedPercent > 100) body.push("  Reported usage is above 100%");
        const bar = this.bar(metric);
        if (bar !== undefined) body.push(`  ${bar}`);
      }
    }
    if (this.loading) body.unshift("Loading usage...");
    const wrapped = body.flatMap((line) => wrapTextWithAnsi(line, inner));
    // Match the overlay's one-row terminal margins; reserve borders and controls.
    const maxHeight = Math.max(5, this.tui.terminal.rows - 2);
    const scrolling = wrapped.length > maxHeight - 3;
    this.pageSize = Math.max(1, maxHeight - 3 - (scrolling ? 1 : 0));
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, wrapped.length - this.pageSize)));
    const lines = [...wrapped.slice(this.offset, this.offset + this.pageSize)];
    if (scrolling) lines.push(`↑↓ scroll ${this.offset + 1}-${Math.min(this.offset + this.pageSize, wrapped.length)}/${wrapped.length}`);
    lines.push("r refresh · Esc close");
    const frame = (line: string) => {
      const text = truncateToWidth(line, inner);
      return `│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`;
    };
    const title = truncateToWidth(" Usage ", Math.max(1, w - 2));
    return [
      `╭${title}${"─".repeat(Math.max(0, w - 2 - visibleWidth(title)))}╮`,
      ...lines.map(frame),
      `╰${"─".repeat(Math.max(0, w - 2))}╯`,
    ].map((line) => truncateToWidth(line, w));
  }

  private bar(metric: UsageMetric): string | undefined {
    const percent = metric.usedPercent ?? (metric.limit !== undefined && metric.limit > 0
      ? metric.used !== undefined ? 100 * metric.used / metric.limit
        : metric.remaining !== undefined ? 100 * (1 - metric.remaining / metric.limit) : undefined
      : metric.remainingPercent !== undefined ? 100 - metric.remainingPercent : undefined);
    if (percent === undefined || !Number.isFinite(percent)) return undefined;
    const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10);
    return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] used`;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape)) return this.close();
    if (data === "r") return this.refresh();
    if (matchesKey(data, Key.up)) this.offset--;
    else if (matchesKey(data, Key.down)) this.offset++;
    else if (matchesKey(data, Key.pageUp)) this.offset -= this.pageSize;
    else if (matchesKey(data, Key.pageDown)) this.offset += this.pageSize;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
    else return;
    this.tui.requestRender();
  }

  clear(): void {
    this.snapshots = undefined;
    if (!this.closed) this.tui.requestRender();
  }

  invalidate(): void { /* Render derives all lines from current state. */ }
  close(): void {
    if (this.closed) return;
    this.dispose();
    this.done();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.sequence++;
  }
}
