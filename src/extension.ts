/**
 * Pi wiring for pi-universal-usage.
 *
 * The factory registers handlers only: no network happens until a session
 * starts or `/usage` is invoked, and background refresh runs in TUI mode only.
 * Every asynchronous path captures one coarse stamp - the activation generation
 * plus the selection's provider, model id, api, and base URL - before it starts,
 * and publishes only while the live selection still stamps the same. Work that
 * outlives its stamp is discarded silently, so a cancelled refresh cannot label
 * the wrong provider.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveTarget, type ResolvedTarget, type TargetResolution } from "./auth.ts";
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

/**
 * The single validity stamp of asynchronous work: the activation generation plus
 * the selection facts a request route is planned from. Header-level routing is
 * deliberately absent, so a model-level routing header change is only noticed at
 * the next selection event or refresh.
 */
interface Stamp {
  generation: number;
  provider: string;
  modelId: string;
  api: string;
  baseUrl: string;
}

/** The selection adopted for one activation generation. */
interface ActiveTarget {
  /** The model this binding was adopted from; Pi may replace or mutate it later. */
  model: Model<any>;
  /** Absent after a failed reconciliation; the selection is kept so a later retry can resolve it. */
  target?: ResolvedTarget;
}

/** One `/usage` entry: a resolvable model, or a provider id with no registered model. */
type ReportTarget = { kind: "model"; model: Model<any> } | { kind: "unresolved"; providerId: string };

function sameLogicalModel(left: Model<any>, right: Model<any>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/** The stamp of a selection, or generation-only facts when nothing is selected. */
function stampOf(generation: number, model: Model<any> | undefined): Stamp {
  return {
    generation,
    provider: model?.provider ?? "",
    modelId: model?.id ?? "",
    api: model?.api ?? "",
    baseUrl: model?.baseUrl ?? "",
  };
}

function sameStamp(left: Stamp, right: Stamp): boolean {
  return (
    left.generation === right.generation &&
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.api === right.api &&
    left.baseUrl === right.baseUrl
  );
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
  /** Increments on every activation and on shutdown; it is the lifetime in the stamp. */
  private generation = 0;
  /** Stamp captured by the `turn_start` that opened the current turn; passive headers need this attribution. */
  private turnStamp: Stamp | undefined;
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
      // A startup emission an earlier handler already started can reach this
      // handler after `session_shutdown`: Pi invalidates the old runner's context
      // afterwards, so reading or scheduling through it would either throw from a
      // guarded getter or rebuild the timer state shutdown just cleared.
      if (this.disposed) return;
      this.config = this.readConfig();
      this.startTimer(ctx);
      const model = ctx.model;
      if (model === undefined) return;
      const refresh = this.backgroundAllowed(ctx);
      if (this.active === undefined) {
        void this.activate(ctx, model, { refresh }).catch(() => undefined);
      } else if (refresh) {
        void this.refreshActive(ctx).catch(() => undefined);
      }
    });

    this.pi.on("model_select", async (event, ctx) => {
      // Pi installs the model before it emits `model_select` and awaits earlier
      // extension handlers without serializing separate emissions, so an older
      // event can arrive after a newer selection was already adopted. The live
      // selection decides: an event that stamps another route describes a
      // selection Pi has already replaced.
      if (this.disposed) return;
      const selected = ctx.model;
      if (
        selected !== undefined &&
        !sameStamp(stampOf(this.generation, selected), stampOf(this.generation, event.model))
      ) {
        return;
      }
      if (this.isCurrentModel(event.model)) {
        // Re-selecting the active logical model is still a chance to pick up
        // rotated credentials or a changed base URL. Adoption must happen even
        // when quota fetching is disabled.
        await this.reselectActive(ctx, event.model);
        return;
      }
      await this.activate(ctx, event.model, { refresh: this.backgroundAllowed(ctx) });
    });

    this.pi.on("turn_start", async (_event, ctx) => {
      this.markTurnBoundary(ctx);
    });

    this.pi.on("agent_end", async (_event, ctx) => {
      if (!this.autoRefreshAllowed(ctx)) return;
      if (this.now() - this.lastAutoRefreshAt < this.config.minRefreshSeconds * 1000) return;
      void this.refreshActive(ctx).catch(() => undefined);
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
    const stamp = stampOf(++this.generation, model);
    this.monitor.cancel();
    this.active = undefined;
    this.lastSnapshot = undefined;
    this.turnStamp = undefined;
    this.paintText(ctx, `${model.provider}: checking usage...`);

    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    // Resolution is asynchronous, and a silent same-ID replacement emits no
    // event: only the live stamp may decide whether this result is still owed.
    if (!this.isCurrent(stamp, ctx)) return;

    if (!resolution.ok) {
      // Keep the selection so a later /usage or selection can retry resolution.
      this.active = { model };
      this.lastSnapshot = this.failureSnapshot(resolution);
      this.paint(ctx);
      return;
    }
    this.active = { model, target: resolution.target };
    if (options.refresh === false) {
      this.paintText(ctx, `${model.provider}: automatic refresh is off`);
      return;
    }
    await this.refreshActive(ctx);
  }

  /**
   * Refresh the active target, re-resolving its effective auth and base URL
   * first. Every caller runs its own attempt: the monitor already deduplicates
   * identical request sequences per identity, and the stamp check prevents a
   * duplicate publication.
   */
  async refreshActive(
    ctx: ExtensionContext,
    options: { force?: boolean; model?: Model<any> } = {},
  ): Promise<TargetSnapshot | undefined> {
    const active = this.active;
    if (this.disposed || active === undefined) return undefined;
    const model = options.model ?? this.currentSelectedModel(ctx, active.model);
    const stamp = stampOf(this.generation, model);
    this.lastAutoRefreshAt = this.now();

    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    if (!this.isCurrent(stamp, ctx)) return undefined;
    if (!resolution.ok) {
      this.active = { model };
      this.turnStamp = undefined;
      this.lastSnapshot = this.failureSnapshot(resolution);
      this.paint(ctx);
      return this.lastSnapshot;
    }
    this.active = { model, target: resolution.target };

    const snapshot = await this.monitor.refresh(
      resolution.target,
      this.config.providers.get(resolution.target.identity.providerId),
      this.config,
      { force: options.force === true },
    );
    // A cancelled run, a replaced activation, or a live selection that moved
    // without an event may not publish.
    if (!this.isCurrent(stamp, ctx)) return undefined;
    this.lastSnapshot = snapshot;
    this.paint(ctx);
    return snapshot;
  }

  /**
   * Adopt a re-selected model object whose provider and model id match the active
   * one: the new object can still change the effective base URL or credentials.
   * With no background refresh, reconciliation stops without a request.
   */
  private async reselectActive(ctx: ExtensionContext, model: Model<any>): Promise<void> {
    const stamp = stampOf(this.generation, model);
    const previousKey = this.active?.target?.identity.key;
    this.monitor.cancel();
    this.turnStamp = undefined;

    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    if (!this.isCurrent(stamp, ctx)) return;
    if (!resolution.ok) {
      this.active = { model };
      this.lastSnapshot = this.failureSnapshot(resolution);
      this.paint(ctx);
      return;
    }
    this.active = { model, target: resolution.target };
    // A changed route must not repaint measurements from the old origin or auth.
    if (previousKey !== resolution.target.identity.key) this.lastSnapshot = undefined;

    if (this.backgroundAllowed(ctx)) {
      await this.refreshActive(ctx, { model });
      return;
    }
    if (this.lastSnapshot === undefined) this.paintText(ctx, `${model.provider}: automatic refresh is off`);
    else this.paint(ctx);
  }

  /**
   * Passive update from an inference response: parse the headers and paint the
   * footer directly. The value is transient - it is not cached, `/usage` never
   * sees it, and the next scheduled or manual refresh replaces it. Attribution
   * holds only while Pi is busy with the target that started the current turn:
   * a response event carries no model identity, so a switch inside the turn
   * makes it ambiguous.
   */
  afterProviderResponse(status: number, headers: Record<string, string>, ctx: ExtensionContext): void {
    const active = this.active;
    const stamp = this.turnStamp;
    if (this.disposed || active?.target === undefined || stamp === undefined) return;
    if (ctx.isIdle()) return;
    if (!this.isCurrent(stamp, ctx)) {
      this.turnStamp = undefined;
      return;
    }
    const snapshot = this.monitor.passiveSnapshot(active.target, headers, status, this.config);
    if (snapshot === undefined) return;
    this.paintText(ctx, formatCompact(snapshot, this.now(), this.config));
  }

  /** A new turn is the only sound boundary for passive response attribution. */
  private markTurnBoundary(ctx: ExtensionContext): void {
    const active = this.active;
    const stamp = this.disposed || active === undefined ? undefined : stampOf(this.generation, active.model);
    this.turnStamp = stamp !== undefined && this.isCurrent(stamp, ctx) ? stamp : undefined;
  }

  /** `/usage [provider ...]`: detailed report for the active and configured providers. */
  async report(ctx: ExtensionCommandContext, args: string): Promise<void> {
    const requested = args
      .split(/\s+/u)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const stamp = this.reportStamp(ctx);

    const snapshots: TargetSnapshot[] = [];
    // The active target is always included; other providers only when the user
    // opted into them before the session (explicit config entries) or asked.
    for (const target of this.reportTargets(ctx, requested)) {
      const snapshot =
        target.kind === "unresolved"
          ? this.unresolvedSnapshot(target.providerId)
          : this.isCurrentModel(target.model)
            ? await this.refreshActive(ctx, { force: true, model: target.model })
            : await this.snapshotForModel(ctx, target.model);
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    // One check before publishing: a report that spans a selection change or a
    // shutdown is discarded silently. Nothing awaits between this and the paint.
    if (!this.isCurrent(stamp, ctx)) return;
    const active = this.lastSnapshot;
    if (active !== undefined && !snapshots.some((snapshot) => snapshot.identity.key === active.identity.key)) {
      snapshots.unshift(active);
    }
    const lines = formatReport(snapshots, this.config, this.now());
    if (ctx.hasUI) {
      ctx.ui.setWidget(REPORT_WIDGET_KEY, lines);
      ctx.ui.notify("pi-universal-usage: report updated", "info");
    } else {
      this.pi.appendEntry("universal-usage-report", { lines });
    }
  }

  /** The stamp this report captured before it started any work. */
  private reportStamp(ctx: ExtensionCommandContext): Stamp {
    const active = this.active;
    return stampOf(this.generation, active === undefined ? ctx.model : this.currentSelectedModel(ctx, active.model));
  }

  /**
   * The single validity rule for active refresh, `/usage`, and passive updates:
   * the host still owns the captured generation and the live selection still
   * stamps the same provider, model id, api, and base URL.
   */
  private isCurrent(stamp: Stamp, ctx: ExtensionContext): boolean {
    if (this.disposed || stamp.generation !== this.generation) return false;
    const selected = ctx.model;
    return selected === undefined || sameStamp(stamp, stampOf(stamp.generation, selected));
  }

  /** Idempotent cleanup for reload, session replacement, and quit. */
  shutdown(ctx?: ExtensionContext): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.active = undefined;
    this.turnStamp = undefined;
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

  /** A resolver failure as a reportable snapshot: no metrics, only the public message. */
  private failureSnapshot(resolution: Extract<TargetResolution, { ok: false }>): TargetSnapshot {
    return {
      identity: resolution.identity,
      status: resolution.status,
      metrics: [],
      error: resolution.error,
      fetchedAt: this.now(),
      source: "cache",
    };
  }

  /**
   * Every selected provider is included; the report processes them one at a
   * time, so the bound is the finite user registry and configuration, not a
   * silent provider cap. A provider with no registered model becomes an
   * unresolved entry instead of disappearing from the selection.
   */
  private reportTargets(ctx: ExtensionCommandContext, requested: readonly string[]): ReportTarget[] {
    const targets: ReportTarget[] = [];
    const active = this.active === undefined ? ctx.model : this.currentSelectedModel(ctx, this.active.model);
    if (active !== undefined && (requested.length === 0 || requested.includes(active.provider))) {
      targets.push({ kind: "model", model: active });
    }

    const providerIds = requested.length > 0 ? requested : [...this.config.providers.keys()];
    for (const providerId of providerIds) {
      if (providerId === active?.provider) continue;
      if (this.config.providers.get(providerId)?.enabled === false) continue;
      const candidate =
        ctx.modelRegistry.getAvailable().find((model) => model.provider === providerId) ??
        ctx.modelRegistry.getAll().find((model) => model.provider === providerId);
      targets.push(candidate === undefined ? { kind: "unresolved", providerId } : { kind: "model", model: candidate });
    }
    return targets;
  }

  /**
   * A requested or configured provider with no registered model is reported as
   * unknown with a notice. There is no model whose credential or origin could be
   * used, so no request is made, and the omission is no longer silent.
   */
  private unresolvedSnapshot(providerId: string): TargetSnapshot {
    return {
      identity: {
        key: `unresolved|${providerId}`,
        providerId,
        modelId: "no model",
        origin: "",
        basePath: "/",
        authSource: "unknown",
        isOAuth: false,
      },
      status: "unknown",
      metrics: [],
      notice: "no registered model could be resolved for this provider",
      fetchedAt: this.now(),
      source: "cache",
    };
  }

  /**
   * One provider of a report that is not the active target: it owns no host
   * binding, so its own resolution and request are the report's own work. The
   * report's final stamp check decides whether the result may be published.
   */
  private async snapshotForModel(ctx: ExtensionCommandContext, model: Model<any>): Promise<TargetSnapshot | undefined> {
    const resolution = await resolveTarget(ctx.modelRegistry, model, { allowInsecureHttp: true });
    if (!resolution.ok) return this.failureSnapshot(resolution);
    return await this.monitor.refresh(
      resolution.target,
      this.config.providers.get(resolution.target.identity.providerId),
      this.config,
      { force: true },
    );
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

  /**
   * Automatic reads are TUI-only and obey `autoRefresh`; explicit `/usage` is
   * unaffected. A disposed host answers before it reads any context field, so a
   * late `agent_end` cannot touch a context Pi has already invalidated.
   */
  private backgroundAllowed(ctx: ExtensionContext): boolean {
    if (this.disposed) return false;
    return this.timersEnabled && this.config.autoRefresh && ctx.mode === "tui";
  }

  private autoRefreshAllowed(ctx: ExtensionContext): boolean {
    return this.backgroundAllowed(ctx) && this.active !== undefined;
  }

  private startTimer(ctx: ExtensionContext): void {
    // The same guarded predicate the lifecycle handlers use: a shutdown that lands
    // before this call must not leave an interval or a captured context behind.
    if (!this.backgroundAllowed(ctx)) return;
    this.stopTimer();
    const intervalMs = Math.max(this.config.refreshSeconds, this.config.minRefreshSeconds) * 1000;
    this.timer = setInterval(() => {
      const refreshContext = this.timerContext;
      if (refreshContext === undefined) return;
      void this.refreshActive(refreshContext).catch(() => undefined);
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
