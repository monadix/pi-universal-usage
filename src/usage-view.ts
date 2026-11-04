import { Key, matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { UsageConfig } from "./config.ts";
import { formatReport } from "./format.ts";
import { plainText } from "./text.ts";
import type { TargetSnapshot } from "./types.ts";

/** One interaction: rendering and countdown ticks never initiate a refresh. */
export class UsageView {
  private snapshots: TargetSnapshot[] | undefined;
  private loading = false;
  private failed = false;
  private closed = false;
  private sequence = 0;
  private offset = 0;
  private pageSize = 1;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly done: () => void;
  private readonly collect: () => Promise<TargetSnapshot[] | undefined>;
  private readonly config: () => UsageConfig;
  private readonly now: () => number;

  constructor(
    tui: Pick<TUI, "requestRender" | "terminal">,
    done: () => void,
    collect: () => Promise<TargetSnapshot[] | undefined>,
    config: () => UsageConfig,
    now: () => number,
  ) {
    this.tui = tui;
    this.done = done;
    this.collect = collect;
    this.config = config;
    this.now = now;
    this.timer = setInterval(() => { if (!this.closed) this.tui.requestRender(); }, 1000);
    this.timer.unref?.();
  }

  refresh(): void {
    if (this.closed) return;
    const sequence = ++this.sequence;
    this.loading = true;
    this.failed = false;
    this.tui.requestRender();
    void this.collect().then((snapshots) => {
      if (this.closed || sequence !== this.sequence) return;
      if (snapshots !== undefined) this.snapshots = snapshots;
      this.loading = false;
      this.tui.requestRender();
    }, () => {
      if (this.closed || sequence !== this.sequence) return;
      this.loading = false;
      this.failed = true;
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    const body: string[] = [];
    if (this.snapshots !== undefined) {
      for (const snapshot of this.snapshots) {
        const lines = formatReport([snapshot], { ...this.config(), problems: [] }, this.now());
        body.push(...lines);
        for (const metric of snapshot.metrics) {
          const percent = metric.usedPercent ?? (metric.limit !== undefined && metric.limit > 0 && metric.remaining !== undefined
            ? 100 * metric.remaining / metric.limit : undefined);
          if (percent === undefined || !Number.isFinite(percent)) continue;
          const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10);
          body.push(`  ${plainText(metric.label)}: [${"#".repeat(filled)}${"-".repeat(10 - filled)}]${metric.usedPercent === undefined ? " remaining" : " used"}`);
        }
      }
      for (const problem of this.config().problems) body.push(`config: ${plainText(problem)}`);
      if (this.snapshots.length === 0) body.push(...formatReport([], this.config(), this.now()));
    }
    if (this.loading) body.unshift("Loading usage...");
    if (this.failed) body.unshift("Refresh failed");
    const wrapped = body.flatMap((line) => wrapTextWithAnsi(line, w));
    this.pageSize = Math.max(1, this.tui.terminal.rows - 6);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, wrapped.length - this.pageSize)));
    const header = wrapTextWithAnsi("Usage  r refresh  Esc close", w)[0] ?? "";
    const footer = wrapTextWithAnsi(`Up/Down scroll  ${Math.min(this.offset + 1, wrapped.length)}-${Math.min(this.offset + this.pageSize, wrapped.length)}/${wrapped.length}`, w)[0] ?? "";
    return [header, ...wrapped.slice(this.offset, this.offset + this.pageSize), footer];
  }

  handleInput(data: string): void {
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
    clearInterval(this.timer);
  }
}
