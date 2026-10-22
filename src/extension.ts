/**
 * Pi wiring for pi-universal-usage.
 *
 * The factory registers handlers only: no network happens until a session
 * starts or `/usage` is invoked, and background refresh runs in TUI mode only.
 * Selection and routing are captured before asynchronous work, and every
 * mutation passes one of two ownership checks: adopting a resolver result, or
 * publishing work bound to a captured activation and source. A cancelled
 * refresh therefore cannot label the wrong provider.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { modelRoutingSignature, resolveTarget, type ResolvedTarget } from "./auth.ts";
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
 * Immutable selection facts captured before asynchronous resolution. The model
 * copy keeps every field Pi needs; only the header map is copied, so mutating
 * Pi's selected model object in place cannot change the route a request was
 * planned for.
 */
interface SelectionBinding {
  model: Model<any>;
  /**
   * Routing signature of the captured selection, with the same header case,
   * order, and `null` suppression semantics as `modelRoutingSignature()`.
   */
  routing: string;
}

/** The selection adopted for one activation generation. */
interface ActiveTarget {
  /** The model object this binding was adopted from; Pi may replace or mutate it later. */
  model: Model<any>;
  /** Facts captured at adoption; every later routing comparison uses these. */
  selection: SelectionBinding;
  /** Absent after a failed reconciliation; the selection is kept so a later retry can resolve it. */
  target?: ResolvedTarget;
}

/** Authority to adopt one asynchronous resolver result. */
interface ResolutionLease {
  generation: number;
  /** Reconciliation order within the activation; omitted for the activation's own resolution. */
  revision?: number;
  selection: SelectionBinding;
}

/** Authority for work already bound to a captured activation and source. */
interface WorkLease {
  generation: number;
  /** Captured routing the live selection must still match; omitted when no binding existed. */
  selection?: SelectionBinding;
  /** Effective source (identity key); omitted when only the activation is bound. */
  source?: string;
  /** Cancellation of the work carrying the lease. */
  signal?: AbortSignal;
}

/** One `/usage` entry: a resolvable model, or a provider id with no registered model. */
type ReportTarget = { kind: "model"; model: Model<any> } | { kind: "unresolved"; providerId: string };

function sameLogicalModel(left: Model<any>, right: Model<any>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * Capture the logical selection and its routing before asynchronous work. A
 * reference to Pi's model object is not an immutable routing fact: Pi replaces
 * or reconfigures it without emitting `model_select` when provider, id, and
 * type are unchanged.
 */
function bindSelection(model: Model<any>): SelectionBinding {
  const bound: Model<any> = { ...model };
  if (model.headers !== undefined) bound.headers = { ...model.headers };
  return { model: bound, routing: modelRoutingSignature(bound) };
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

    this.pi.on("turn_start", async (_event, ctx) => {
      this.markTurnBoundary(ctx);
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
    const selection = bindSelection(model);
    this.abortRefresh();
    this.active = undefined;
    this.lastSnapshot = undefined;
    this.passiveAttribution = undefined;
    this.monitor.cancel();
    this.paintText(ctx, `${model.provider}: checking usage...`);

    const resolution = await resolveTarget(ctx.modelRegistry, selection.model, { allowInsecureHttp: true });
    // The activation's resolution is the first of its generation, so only the
    // live route can invalidate it. A silent same-ID replacement while it was
    // pending must neither paint its success or failure nor start a request.
    if (!this.adoptsResolution({ generation, selection }, ctx)) return;

    if (!resolution.ok) {
      // Keep the selection so a later /usage or selection can retry resolution.
      this.active = { model, selection };
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
    this.active = { model, selection, target: resolution.target };
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
    // Begin every new reconciliation from the live routing: the selected object
    // may have been mutated in place since it was adopted, and the resolver must
    // describe the route the user is on now. A resolution handed in by the caller
    // is already bound to the capture it was produced from.
    const selection = options.resolved !== undefined ? active.selection : bindSelection(model);
    // The adopted binding is replaced by the resolver result, never before it.
    // Pi can substitute an equivalent model object without an event, so
    // dropping the binding eagerly would discard a still-sound turn attribution
    // before the resolver can show that the effective identity is unchanged.
    const target =
      options.resolved ?? (await this.reconcileActive(ctx, model, { generation, revision, selection }));
    if (target === undefined) return undefined;
    // This request is bound to the reconciled source: the captured activation,
    // route and cancellation decide, not the reconciliation order.
    const bound: WorkLease = { generation, selection, source: target.identity.key };
    if (!this.holdsWork(bound, ctx)) return undefined;

    const key = target.identity.key;
    const existing = this.refreshWork;
    if (existing !== undefined && existing.generation === generation && existing.key === key) {
      return existing.promise;
    }
    this.abortRefresh();

    const controller = new AbortController();
    this.lastAutoRefreshAt = this.now();
    const work: WorkLease = { ...bound, signal: controller.signal };
    const promise = (async (): Promise<TargetSnapshot | undefined> => {
      const snapshot = await this.monitor.refresh(
        target,
        this.config.providers.get(target.identity.providerId),
        this.config,
        { force: options.force === true, signal: controller.signal },
      );
      // A cancelled run, a replaced activation, a rotated source, or a live
      // selection that moved without an event may not publish.
      if (!this.holdsWork(work, ctx)) return undefined;
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
    const selection = bindSelection(model);
    const previousKey = this.active?.target?.identity.key;
    const previousAttribution = this.passiveAttribution;
    this.abortRefresh();
    // Detach the cancelled monitor run as well. Otherwise an unchanged identity
    // can cause the replacement refresh to join the cancelled promise.
    this.monitor.cancel();
    this.passiveAttribution = undefined;

    // A target here already passed the adoption check: it is the newest
    // reconciliation of this activation and the live route still matches it.
    const lease: ResolutionLease = { generation, revision, selection };
    const target = await this.reconcileActive(ctx, model, lease);
    // Adoption happened one asynchronous boundary ago. A shutdown, a newer
    // activation, or a newer reconciliation in between revokes this reselection
    // before it may restore attribution, change the accepted view, or touch the
    // context its work would publish through.
    if (target === undefined || !this.adoptsResolution(lease, ctx)) return;
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

  /** Re-resolve a captured selection and replace the active binding when this resolution still owns it. */
  private async reconcileActive(
    ctx: ExtensionContext,
    model: Model<any>,
    lease: ResolutionLease,
  ): Promise<ResolvedTarget | undefined> {
    const resolution = await resolveTarget(ctx.modelRegistry, lease.selection.model, { allowInsecureHttp: true });
    // Auth resolution is asynchronous: only the newest reconciliation for this
    // activation may mutate the active binding, even when an older resolver
    // completes after a newer failure or routing change.
    if (!this.adoptsResolution(lease, ctx)) return undefined;
    if (!resolution.ok) {
      // A failed reconciliation invalidates older work: its controller is
      // aborted and the old target can no longer satisfy a work lease.
      this.abortRefresh();
      this.monitor.cancel();
      this.active = { model, selection: lease.selection };
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
    this.active = { model, selection: lease.selection, target: resolution.target };
    if (previous !== resolution.target.identity.key) this.passiveAttribution = undefined;
    return resolution.target;
  }

  /**
   * Passive update from an inference response. Attribution is sound only while
   * Pi is busy with the target that started the current turn: a response event
   * carries no model identity, so a switch during the turn makes it ambiguous.
   */
  afterProviderResponse(status: number, headers: Record<string, string>, ctx: ExtensionContext): void {
    const target = this.passiveBinding(ctx);
    if (target === undefined) return;
    if (ctx.isIdle()) return;
    const snapshot = this.monitor.applyPassiveHeaders(target, headers, status, this.config);
    if (snapshot === undefined) return;
    this.lastSnapshot = snapshot;
    this.paint(ctx);
  }

  /**
   * The target a response may still be attributed to, or undefined when the
   * attribution is no longer sound. Validity is decided here, before the monitor
   * measurement is written, not only before the footer is painted.
   */
  private passiveBinding(ctx: ExtensionContext): ResolvedTarget | undefined {
    const active = this.active;
    const attribution = this.passiveAttribution;
    if (this.disposed || active?.target === undefined || attribution === undefined) return undefined;
    const bound: WorkLease = {
      generation: attribution.generation,
      selection: active.selection,
      source: active.target.identity.key,
    };
    if (this.holdsWork(bound, ctx)) return active.target;
    // A selection that moved to another route without an event cannot be
    // attributed at all; drop the attribution instead of filing these headers
    // under the previously bound routing.
    if (!this.routeHolds(active.selection, ctx)) this.passiveAttribution = undefined;
    return undefined;
  }

  /** A new turn is the only sound boundary for passive response attribution. */
  private markTurnBoundary(ctx: ExtensionContext): void {
    const active = this.active;
    if (this.disposed || active?.target === undefined) {
      this.passiveAttribution = undefined;
      return;
    }
    // A same-ID selection Pi did not report (a changed base URL is not part of
    // its model equality check) is unknown routing for this turn. Refuse
    // attribution instead of filing its headers under the previously bound one.
    if (!this.routeHolds(active.selection, ctx)) {
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

    // While the initial activation is still resolving there is no adopted binding
    // to compare against, yet the command reports the live selection. Capture it
    // so this report's work keeps matching the route it started from.
    const unadopted = this.active === undefined ? this.captureSelected(ctx) : undefined;
    const snapshots: TargetSnapshot[] = [];
    // The effective source this report belongs to. The active provider is
    // reported first, so its own reconciliation re-anchors the guard; a source
    // change caused by later work (a rotated credential or a changed same-ID
    // route) cancels the report instead of publishing older measurements.
    let source = this.activeSourceToken();
    // The active target is always included; other providers only when the user
    // opted into them before the session (explicit config entries) or asked.
    for (const target of this.reportTargets(ctx, requested)) {
      const isActive = target.kind === "model" && this.isCurrentModel(target.model);
      const snapshot =
        target.kind === "unresolved"
          ? this.unresolvedSnapshot(target.providerId)
          : await this.snapshotForModel(ctx, target.model, generation, isActive ? undefined : source, unadopted);
      if (isActive) {
        // The active provider's own reconciliation may re-anchor this report,
        // but only under the authority its outcome carries. Reading the current
        // source here instead would let a source adopted after that outcome
        // authorize measurements collected under the previous one.
        const anchor = this.activeReportAnchor(snapshot);
        if (anchor === undefined) return;
        source = anchor;
      }
      // A model switch, shutdown, or effective source change cancels the report
      // silently: it must not fetch the next provider or publish measurements
      // from an older source.
      if (!this.reportStillValid(generation, source, ctx, unadopted)) return;
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    if (!this.reportStillValid(generation, source, ctx, unadopted)) return;
    const active = this.lastSnapshot;
    const activeTargetKey = this.active?.target?.identity.key;
    // With no reconciled target the last snapshot is this attempt's failure
    // state; with one, a key mismatch means it belongs to an older source.
    const activeIsCurrent = active !== undefined && (activeTargetKey === undefined || active.identity.key === activeTargetKey);
    if (activeIsCurrent && !snapshots.some((snapshot) => snapshot.identity.key === active.identity.key)) {
      snapshots.unshift(active);
    }

    const lines = formatReport(snapshots, this.config, this.now());
    // Pi rejects a stale context after a reload; stop before touching it.
    if (!this.reportStillValid(generation, source, ctx, unadopted)) return;
    if (ctx.hasUI) {
      ctx.ui.setWidget(REPORT_WIDGET_KEY, lines);
      ctx.ui.notify("pi-universal-usage: report updated", "info");
    } else {
      this.pi.appendEntry("universal-usage-report", { lines });
    }
  }

  /**
   * The effective credential/routing source, or `-` when no target is
   * reconciled. The identity key already covers provider, origin, base path,
   * auth source, and the auth/routing header fingerprint.
   */
  private activeSourceToken(): string {
    return this.active?.target?.identity.key ?? "-";
  }

  /**
   * The source a report may continue under once its active provider has been
   * attempted, or undefined when that attempt left no authority to report from.
   * A returned snapshot was accepted by its own reconciliation, so it anchors
   * the report only while the host still holds that source. Without a snapshot,
   * the target-less binding of a sanitized resolver failure is the only outcome
   * that carries an authority of its own; a rejected or cancelled attempt
   * carries none and must not fall back to the current source.
   */
  private activeReportAnchor(snapshot: TargetSnapshot | undefined): string | undefined {
    if (snapshot !== undefined) {
      const current = this.activeSourceToken();
      return current === snapshot.identity.key ? current : undefined;
    }
    if (this.active?.target !== undefined || this.lastSnapshot === undefined) return undefined;
    return this.activeSourceToken();
  }

  /**
   * Report work is bound to the activation generation and effective source it
   * started with. The route it may publish under is the current binding, because
   * the active provider's own reconciliation re-anchors both; while no binding
   * has been adopted yet, the route the command captured before its first await
   * is the one its work must still match.
   */
  private reportStillValid(
    generation: number,
    source: string | undefined,
    ctx: ExtensionContext,
    unadopted: SelectionBinding | undefined,
  ): boolean {
    return this.holdsWork({ generation, selection: this.active?.selection ?? unadopted, source }, ctx);
  }

  /** The live selection, captured for work that has no adopted binding to compare against yet. */
  private captureSelected(ctx: ExtensionContext): SelectionBinding | undefined {
    const selected = ctx.model;
    return selected === undefined ? undefined : bindSelection(selected);
  }

  /**
   * May this asynchronous resolver result replace the active binding? It must be
   * the newest reconciliation of the current activation, and the live selection
   * must still route the captured model the same way.
   */
  private adoptsResolution(lease: ResolutionLease, ctx: ExtensionContext): boolean {
    if (this.disposed || lease.generation !== this.generation) return false;
    if (lease.revision !== undefined && lease.revision !== this.reconcileRevision) return false;
    return this.routeHolds(lease.selection, ctx);
  }

  /**
   * May this already-bound work still mutate or publish? Its captured activation,
   * source, and route must be current and its cancellation must not have fired.
   * Reconciliation order deliberately plays no part, so equivalent same-target
   * work joins the run it would otherwise abort.
   */
  private holdsWork(lease: WorkLease, ctx: ExtensionContext): boolean {
    if (this.disposed || lease.generation !== this.generation) return false;
    if (lease.signal?.aborted === true) return false;
    if (lease.source !== undefined && this.activeSourceToken() !== lease.source) return false;
    return lease.selection === undefined || this.routeHolds(lease.selection, ctx);
  }

  /**
   * True when the live selection still routes the captured logical model the same
   * way. Pi suppresses `model_select` when provider, model id, and type are
   * unchanged, even if the new model object points at another base URL or
   * routing header, so only the live model getter reveals such a change. A
   * different logical model emits `model_select` and starts a new generation.
   */
  private routeHolds(selection: SelectionBinding, ctx: ExtensionContext): boolean {
    const selected = ctx.model;
    if (selected === undefined || !sameLogicalModel(selected, selection.model)) return true;
    return modelRoutingSignature(selected) === selection.routing;
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

  private async snapshotForModel(
    ctx: ExtensionCommandContext,
    model: Model<any>,
    generation: number,
    source: string | undefined,
    unadopted: SelectionBinding | undefined,
  ): Promise<TargetSnapshot | undefined> {
    if (this.active !== undefined && this.isCurrentModel(model)) {
      return this.refreshActive(ctx, { reason: "command", force: true, model });
    }
    const selection = bindSelection(model);
    const resolution = await resolveTarget(ctx.modelRegistry, selection.model, { allowInsecureHttp: true });
    if (!this.reportStillValid(generation, source, ctx, unadopted)) return undefined;
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
    if (!this.reportStillValid(generation, source, ctx, unadopted)) return undefined;
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
