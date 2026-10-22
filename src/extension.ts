/**
 * Pi wiring for pi-universal-usage.
 *
 * The factory registers handlers only: no network happens until a session
 * starts or `/usage` is invoked, and background refresh runs in TUI mode only.
 * Every result is checked against the activation generation and the active
 * target identity before it can be painted, so a cancelled refresh can never
 * label the wrong provider.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveTarget, type ResolvedTarget } from "./auth.ts";
import { loadConfig, STATUS_KEY, type UsageConfig } from "./config.ts";
import { formatCompact, formatReport } from "./format.ts";
import { plainText } from "./text.ts";
import { UsageMonitor } from "./monitor.ts";
import type { TargetSnapshot } from "./types.ts";

export const COMMAND_NAME = "usage";
export const REPORT_WIDGET_KEY = "universal-usage-report";

export interface HostOptions {
  monitor?: UsageMonitor;
  config?: UsageConfig;
  loadConfig?: () => UsageConfig;
  now?: () => number;
  /** Disable the periodic timer (tests and non-TUI hosts). */
  timers?: boolean;
}

interface ActiveTarget {
  model: Model<any>;
  /** Absent after a failed reconciliation; the model is kept so a later retry can resolve it. */
  target?: ResolvedTarget;
}

function sameLogicalModel(left: Model<any>, right: Model<any>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

export class UniversalUsageHost {
  private readonly pi: ExtensionAPI;
  private readonly monitor: UsageMonitor;
  private readonly readConfig: () => UsageConfig;
  private readonly now: () => number;
  private readonly timersEnabled: boolean;

  private config: UsageConfig;
  private active: ActiveTarget | undefined;
  private lastSnapshot: TargetSnapshot | undefined;
  private generation = 0;
  /** Orders asynchronous credential reconciliations within one activation generation. */
  private reconcileRevision = 0;
  /** Work shared by concurrent refreshes of one identity; never aborted by a same-target join. */
  private refreshWork: { key: string; generation: number; controller: AbortController; promise: Promise<TargetSnapshot | undefined> } | undefined;
  /** The target that started the current turn; passive headers need this attribution. */
  private passiveAttribution: { identityKey: string; generation: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Kept only while the timer exists; cleared by shutdown and session changes. */
  private timerContext: ExtensionContext | undefined;
  private lastAutoRefreshAt = 0;
  private disposed = false;

  constructor(pi: ExtensionAPI, options: HostOptions = {}) {
    this.pi = pi;
    this.monitor = options.monitor ?? new UsageMonitor({ ...(options.now !== undefined ? { now: options.now } : {}) });
    const config = options.config;
    this.readConfig = options.loadConfig ?? (config !== undefined ? () => config : () => loadConfig());
    this.now = options.now ?? (() => Date.now());
    this.timersEnabled = options.timers !== false;
    this.config = config ?? this.readConfig();
  }

  /** Register command and lifecycle handlers. Nothing here opens a socket. */
  register(): void {
    this.pi.registerCommand(COMMAND_NAME, {
      description: "Show read-only provider usage, quota windows, and balances",
      handler: async (args, ctx) => {
        await this.report(ctx, args);
      },
    });

    this.pi.on("session_start", async (_event, ctx) => {
      this.config = this.readConfig();
      this.startTimer(ctx);
      const model = ctx.model;
      if (model === undefined) return;
      const refresh = this.backgroundAllowed(ctx);
      if (this.active === undefined) {
        void this.activate(ctx, model, { refresh }).catch(() => undefined);
      } else if (refresh) {
        void this.refreshActive(ctx, { reason: "startup" }).catch(() => undefined);
      }
    });

    this.pi.on("model_select", async (event, ctx) => {
      if (this.isCurrentModel(event.model)) {
        // Re-selecting the active logical model is still a chance to pick up
        // rotated credentials or changed same-ID routing. Adoption must happen
        // even when quota fetching is disabled.
        await this.reselectActive(ctx, event.model);
        return;
      }
      await this.activate(ctx, event.model, { refresh: this.backgroundAllowed(ctx) });
    });

    this.pi.on("turn_start", async () => {
      this.markTurnBoundary();
    });

    this.pi.on("agent_end", async (_event, ctx) => {
      if (!this.autoRefreshAllowed(ctx)) return;
      if (this.now() - this.lastAutoRefreshAt < this.config.minRefreshSeconds * 1000) return;
      void this.refreshActive(ctx, { reason: "after-turn" }).catch(() => undefined);
    });

    this.pi.on("after_provider_response", async (event, ctx) => {
      this.afterProviderResponse(event.status, event.headers, ctx);
    });

    this.pi.on("session_shutdown", async (_event, ctx) => {
      this.shutdown(ctx);
    });
  }

  /** Resolve and, when asked, refresh the given model as the active target. */
  async activate(ctx: ExtensionContext, model: Model<any>, options: { refresh?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.abortRefresh();
    this.active = undefined;
    this.lastSnapshot = undefined;
    this.passiveAttribution = undefined;
    this.monitor.cancel();
    this.paintText(ctx, `${model.provider}: checking usage...`);

    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    if (generation !== this.generation || this.disposed) return;

    if (!resolution.ok) {
      // Keep the model so a later /usage or selection can retry resolution.
      this.active = { model };
      this.lastSnapshot = {
        identity: resolution.identity,
        status: resolution.status,
        metrics: [],
        error: resolution.error,
        fetchedAt: this.now(),
        source: "cache",
      };
      this.paint(ctx);
      return;
    }
    this.active = { model, target: resolution.target };
    if (options.refresh === false) {
      this.paintText(ctx, `${model.provider}: automatic refresh is off`);
      return;
    }
    await this.refreshActive(ctx, { reason: "model", resolved: resolution.target });
  }

  /**
   * Refresh the active target. A new refresh re-resolves the effective auth and
   * base URL first, and a concurrent refresh of the same identity joins the
   * work already in flight instead of aborting the request it would then await.
   */
  async refreshActive(
    ctx: ExtensionContext,
    options: { reason: string; force?: boolean; resolved?: ResolvedTarget; model?: Model<any> },
  ): Promise<TargetSnapshot | undefined> {
    const active = this.active;
    if (this.disposed || active === undefined) return undefined;
    const generation = this.generation;
    const revision = ++this.reconcileRevision;
    const model =
      options.model ?? (options.resolved !== undefined ? active.model : this.currentSelectedModel(ctx, active.model));
    if (model !== active.model) {
      this.active = { model };
      this.passiveAttribution = undefined;
    }
    const target = options.resolved ?? (await this.reconcileActive(ctx, model, generation, revision));
    if (target === undefined || this.disposed || generation !== this.generation) return undefined;

    const key = target.identity.key;
    const existing = this.refreshWork;
    if (existing !== undefined && existing.generation === generation && existing.key === key) {
      return existing.promise;
    }
    this.abortRefresh();

    const controller = new AbortController();
    this.lastAutoRefreshAt = this.now();
    const promise = (async (): Promise<TargetSnapshot | undefined> => {
      const snapshot = await this.monitor.refresh(
        target,
        this.config.providers.get(target.identity.providerId),
        this.config,
        { force: options.force === true, signal: controller.signal },
      );
      if (controller.signal.aborted) return undefined;
      if (this.disposed || generation !== this.generation) return undefined;
      if (this.active?.target?.identity.key !== snapshot.identity.key) return undefined;
      this.lastSnapshot = snapshot;
      this.paint(ctx);
      return snapshot;
    })();
    this.refreshWork = { key, generation, controller, promise };
    try {
      return await promise;
    } finally {
      if (this.refreshWork?.promise === promise) this.refreshWork = undefined;
    }
  }

  /**
   * Adopt a re-selected model object whose provider and model id match the
   * active one. The new object can still change the effective base URL or
   * routing, so always reconcile it. First cancel work and passive attribution
   * from the previous selection: a late result must not pass unchanged guards.
   * With no background refresh, reconciliation stops without a request.
   */
  private async reselectActive(ctx: ExtensionContext, model: Model<any>): Promise<void> {
    const generation = this.generation;
    const revision = ++this.reconcileRevision;
    const previousKey = this.active?.target?.identity.key;
    const previousAttribution = this.passiveAttribution;
    this.abortRefresh();
    // Detach the cancelled monitor run as well. Otherwise an unchanged identity
    // can cause the replacement refresh to join the cancelled promise.
    this.monitor.cancel();
    this.passiveAttribution = undefined;

    const target = await this.reconcileActive(ctx, model, generation, revision);
    if (target === undefined || this.disposed || generation !== this.generation) return;
    if (previousKey !== target.identity.key) {
      // The route changed; do not repaint measurements from the old origin/auth.
      this.lastSnapshot = undefined;
    } else {
      // Same effective identity and generation: prior turn attribution stays sound.
      this.passiveAttribution = previousAttribution;
    }

    if (this.backgroundAllowed(ctx)) {
      await this.refreshActive(ctx, { reason: "model", model, resolved: target });
      return;
    }
    if (this.lastSnapshot === undefined) this.paintText(ctx, `${model.provider}: automatic refresh is off`);
    else this.paint(ctx);
  }

  /** Re-resolve the active model and replace its target when auth or routing changed. */
  private async reconcileActive(
    ctx: ExtensionContext,
    model: Model<any>,
    generation: number,
    revision: number,
  ): Promise<ResolvedTarget | undefined> {
    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    // Auth resolution is asynchronous. Only the newest reconciliation for this
    // activation may mutate the active target, even when an older resolver
    // completes after a newer failure or routing change.
    if (this.disposed || generation !== this.generation || revision !== this.reconcileRevision) return undefined;
    if (!resolution.ok) {
      // A failed reconciliation invalidates older work: its controller is
      // aborted and the old target can no longer satisfy completion guards.
      this.abortRefresh();
      this.monitor.cancel();
      this.active = { model };
      this.passiveAttribution = undefined;
      this.lastSnapshot = {
        identity: resolution.identity,
        status: resolution.status,
        metrics: [],
        error: resolution.error,
        fetchedAt: this.now(),
        source: "cache",
      };
      this.paint(ctx);
      return undefined;
    }
    const previous = this.active?.target?.identity.key;
    this.active = { model, target: resolution.target };
    if (previous !== resolution.target.identity.key) this.passiveAttribution = undefined;
    return resolution.target;
  }

  /**
   * Passive update from an inference response. Attribution is sound only while
   * Pi is busy with the target that started the current turn: a response event
   * carries no model identity, so a switch during the turn makes it ambiguous.
   */
  afterProviderResponse(status: number, headers: Record<string, string>, ctx: ExtensionContext): void {
    const active = this.active;
    const attribution = this.passiveAttribution;
    if (this.disposed || active?.target === undefined || attribution === undefined) return;
    if (attribution.generation !== this.generation) return;
    if (attribution.identityKey !== active.target.identity.key) return;
    if (ctx.isIdle()) return;
    const snapshot = this.monitor.applyPassiveHeaders(active.target, headers, status, this.config);
    if (snapshot === undefined) return;
    this.lastSnapshot = snapshot;
    this.paint(ctx);
  }

  /** A new turn is the only sound boundary for passive response attribution. */
  private markTurnBoundary(): void {
    const active = this.active;
    if (this.disposed || active?.target === undefined) {
      this.passiveAttribution = undefined;
      return;
    }
    this.passiveAttribution = { identityKey: active.target.identity.key, generation: this.generation };
  }

  private abortRefresh(): void {
    this.refreshWork?.controller.abort();
    this.refreshWork = undefined;
  }

  /** `/usage [provider ...]`: detailed report for the active and configured providers. */
  async report(ctx: ExtensionCommandContext, args: string): Promise<void> {
    const generation = this.generation;
    const requested = args
      .split(/\s+/u)
      .map((part) => part.trim())
      .filter((part) => part !== "");

    const snapshots: TargetSnapshot[] = [];
    // The active target is always included; other providers only when the user
    // opted into them before the session (explicit config entries) or asked.
    for (const model of this.reportModels(ctx, requested)) {
      const snapshot = await this.snapshotForModel(ctx, model, generation);
      // A model switch or shutdown cancels the report silently: it must not
      // fetch the next provider or publish measurements from an older session.
      if (this.reportCancelled(generation)) return;
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    if (this.reportCancelled(generation)) return;
    const active = this.lastSnapshot;
    if (active !== undefined && !snapshots.some((snapshot) => snapshot.identity.key === active.identity.key)) {
      snapshots.unshift(active);
    }

    const lines = formatReport(snapshots, this.config, this.now());
    // Pi rejects a stale context after a reload; stop before touching it.
    if (this.reportCancelled(generation)) return;
    if (ctx.hasUI) {
      ctx.ui.setWidget(REPORT_WIDGET_KEY, lines);
      ctx.ui.notify("pi-universal-usage: report updated", "info");
    } else {
      this.pi.appendEntry("universal-usage-report", { lines });
    }
  }

  /** A report may only continue and publish within the activation generation it started in. */
  private reportCancelled(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  /** Idempotent cleanup for reload, session replacement, and quit. */
  shutdown(ctx?: ExtensionContext): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.abortRefresh();
    this.active = undefined;
    this.passiveAttribution = undefined;
    this.stopTimer();
    this.monitor.dispose();
    try {
      ctx?.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // The UI may already be torn down during shutdown.
    }
  }

  private isCurrentModel(model: Model<any>): boolean {
    return this.active !== undefined && sameLogicalModel(this.active.model, model);
  }

  /** The selected model object when it still represents the active logical model. */
  private currentSelectedModel(ctx: ExtensionContext, activeModel: Model<any>): Model<any> {
    const selected = ctx.model;
    return selected !== undefined && sameLogicalModel(selected, activeModel) ? selected : activeModel;
  }

  /**
   * Every selected provider is included; the report processes them one at a
   * time, so the bound is the finite user registry and configuration, not a
   * silent provider cap.
   */
  private reportModels(ctx: ExtensionCommandContext, requested: readonly string[]): Model<any>[] {
    const models: Model<any>[] = [];
    const active = this.active === undefined ? ctx.model : this.currentSelectedModel(ctx, this.active.model);
    if (active !== undefined && (requested.length === 0 || requested.includes(active.provider))) models.push(active);

    const providerIds = requested.length > 0 ? requested : [...this.config.providers.keys()];
    for (const providerId of providerIds) {
      if (providerId === active?.provider) continue;
      if (this.config.providers.get(providerId)?.enabled === false) continue;
      const candidate =
        ctx.modelRegistry.getAvailable().find((model) => model.provider === providerId) ??
        ctx.modelRegistry.getAll().find((model) => model.provider === providerId);
      if (candidate !== undefined) models.push(candidate);
    }
    return models;
  }

  private async snapshotForModel(
    ctx: ExtensionCommandContext,
    model: Model<any>,
    generation: number,
  ): Promise<TargetSnapshot | undefined> {
    if (this.active !== undefined && this.isCurrentModel(model)) {
      return this.refreshActive(ctx, { reason: "command", force: true, model });
    }
    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    if (this.reportCancelled(generation)) return undefined;
    if (!resolution.ok) {
      return {
        identity: resolution.identity,
        status: resolution.status,
        metrics: [],
        error: resolution.error,
        fetchedAt: this.now(),
        source: "cache",
      };
    }
    const snapshot = await this.monitor.refresh(
      resolution.target,
      this.config.providers.get(resolution.target.identity.providerId),
      this.config,
      { force: true },
    );
    // The monitor may return a cancelled or post-shutdown placeholder snapshot;
    // a stale report discards it instead of reporting it as quota data.
    if (this.reportCancelled(generation)) return undefined;
    return snapshot;
  }

  private paint(ctx: ExtensionContext): void {
    const snapshot = this.lastSnapshot;
    if (snapshot === undefined) return;
    this.paintText(ctx, formatCompact(snapshot, this.now(), this.config));
  }

  private paintText(ctx: ExtensionContext, text: string): void {
    try {
      // Model/provider ids can come from runtime registrations; status text is
      // another terminal output boundary.
      ctx.ui.setStatus(STATUS_KEY, plainText(text));
    } catch {
      // Status painting is best-effort in non-interactive modes.
    }
  }

  /** Automatic reads are TUI-only and obey `autoRefresh`; explicit `/usage` is unaffected. */
  private backgroundAllowed(ctx: ExtensionContext): boolean {
    return this.timersEnabled && this.config.autoRefresh && ctx.mode === "tui";
  }

  private autoRefreshAllowed(ctx: ExtensionContext): boolean {
    return this.backgroundAllowed(ctx) && this.active !== undefined;
  }

  private startTimer(ctx: ExtensionContext): void {
    if (!this.timersEnabled || !this.config.autoRefresh || ctx.mode !== "tui") return;
    this.stopTimer();
    const intervalMs = Math.max(this.config.refreshSeconds, this.config.minRefreshSeconds) * 1000;
    this.timer = setInterval(() => {
      const refreshContext = this.timerContext;
      if (refreshContext === undefined) return;
      void this.refreshActive(refreshContext, { reason: "interval" }).catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
    this.timerContext = ctx;
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.timerContext = undefined;
  }
}

/** Factory used by the Pi extension entry point. */
export function createUsageExtension(pi: ExtensionAPI, options: HostOptions = {}): UniversalUsageHost {
  const host = new UniversalUsageHost(pi, options);
  host.register();
  return host;
}
