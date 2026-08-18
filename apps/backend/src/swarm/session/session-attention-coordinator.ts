import { randomUUID } from "node:crypto";

import type {
  AgentDescriptor,
  AgentStatus,
  ManagerProfile,
  SessionAttention,
  SessionAttentionChange,
  SessionAttentionReason,
} from "@forge/protocol";

import type { SessionAttentionEligibilityPredicate } from "./session-attention-eligibility.js";
import {
  cloneSessionAttentionState,
  type PersistedSessionAttention,
  type PersistedSessionAttentionRecord,
  type PersistedSessionAttentionState,
  SessionAttentionStore,
} from "./session-attention-store.js";

export interface SessionAttentionSessionSnapshot {
  /** Current, committed descriptor for the owning manager session. */
  manager: AgentDescriptor;
  /** Current, committed owning profile. */
  profile: ManagerProfile | undefined;
  /** Uses AgentDirectory's existing streaming-worker predicate. */
  activeWorkerCount: number;
  /** Uses SwarmChoiceService's committed pending-choice map. */
  pendingChoiceCount: number;
  /** Current committed owned-worker error evidence for restart-safe reasons. */
  hasTerminallyErroredWorker: boolean;
  /**
   * An accepted turn is an observation barrier, not a fourth quiescence term.
   * REQUIRED so a producer cannot silently bypass the barrier by omitting it.
   *
   * A non-zero count arms the barrier for the epoch. Dropping back to zero does
   * NOT release it: TurnContextCoordinator dequeues on the provider's user
   * message_start, which can precede the manager's streaming projection, so
   * settling there would broadcast a completion that never happened. Release
   * happens only via an authoritative manager streaming transition or an
   * explicit releaseContinuationBarrier() when there is no continuation.
   */
  pendingTurnContextCount: number;
}

export interface SessionAttentionStatusObservation extends SessionAttentionSessionSnapshot {
  agentId: string;
  source: "manager" | "owned_worker";
  previousStatus: AgentStatus;
  nextStatus: AgentStatus;
  /** Timestamp committed by the descriptor producer, before coordinator queueing. */
  transitionedAt: string;
}

export interface SessionAttentionReasonInput {
  sessionAgentId: string;
  profileId: string;
  workStartedAt: string;
  /** True when an eligible manager or owned worker entered error in this epoch. */
  hadError: boolean;
}

export interface SessionAttentionCoordinatorSnapshot {
  revision: number;
  attentions: SessionAttention[];
}

export interface SessionAttentionDismissResult {
  revision: number;
  changes: SessionAttentionChange[];
}

export interface SessionAttentionCoordinatorOptions {
  store: SessionAttentionStore;
  /** Required WP1 policy seam; the coordinator never inlines eligibility. */
  isEligible: SessionAttentionEligibilityPredicate;
  /** Called only after an armed epoch has qualified to settle. */
  getReason?: (input: SessionAttentionReasonInput) => SessionAttentionReason | undefined | Promise<SessionAttentionReason | undefined>;
  now?: () => string;
  randomId?: () => string;
  /**
   * Called only after the corresponding store replacement completed. Carries
   * both the batch delta (for correlated responses) and the complete visible
   * state, so publishers can broadcast self-contained snapshots that heal any
   * previously dropped delivery.
   */
  onChange?: (update: { revision: number; changes: SessionAttentionChange[]; attentions: SessionAttention[] }) => void;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

interface StateMutation<T> {
  value: T;
  state?: PersistedSessionAttentionState;
  changes?: SessionAttentionChange[];
}

interface MutationContext {
  /** True when folding a newer natural fact into an undurable retry target. */
  coalescingPending: boolean;
}

interface PendingCommit {
  state: PersistedSessionAttentionState;
  changes: SessionAttentionChange[];
}

/**
 * Owns the one-item-per-work-epoch attention aggregate. Producers only report
 * committed facts; this class is the sole owner of arming, settling, exact
 * dismissal, revisions, and store-before-publication ordering.
 */
export class SessionAttentionCoordinator {
  private readonly store: SessionAttentionStore;
  private readonly isEligible: SessionAttentionEligibilityPredicate;
  private readonly getReason: (input: SessionAttentionReasonInput) => SessionAttentionReason | undefined | Promise<SessionAttentionReason | undefined>;
  private readonly now: () => string;
  private readonly randomId: () => string;
  private readonly onChange: (update: { revision: number; changes: SessionAttentionChange[]; attentions: SessionAttention[] }) => void;
  private readonly log: (message: string, details?: Record<string, unknown>) => void;

  private initialized = false;
  private state: PersistedSessionAttentionState = { version: 1, revision: 0, sessions: {} };
  private pendingCommit: PendingCommit | undefined;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: SessionAttentionCoordinatorOptions) {
    this.store = options.store;
    this.isEligible = options.isEligible;
    this.getReason = options.getReason ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    this.onChange = options.onChange ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
  }

  /** Load durable state before Builder bootstrap snapshots can be served. */
  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.initialized) return;
      this.state = await this.store.load();
      this.initialized = true;
    });
  }

  /**
   * Reconciles only persisted armed epochs. Idle inventory with no record is a
   * baseline, not evidence of work, so it cannot create attention here.
   */
  async reconcileAfterBoot(sessions: Iterable<SessionAttentionSessionSnapshot>): Promise<void> {
    await this.runNatural(async () => this.applyMutation(async (state) => {
      const bySessionId = new Map<string, SessionAttentionSessionSnapshot>();
      for (const session of sessions) {
        bySessionId.set(session.manager.agentId, session);
      }

      const next = cloneSessionAttentionState(state);
      const changes: SessionAttentionChange[] = [];
      let changed = false;

      for (const sessionAgentId of Object.keys(next.sessions).sort()) {
        const record = next.sessions[sessionAgentId];
        const session = bySessionId.get(sessionAgentId);
        if (!session || !this.sessionIsEligible(session)) {
          delete next.sessions[sessionAgentId];
          changed = true;
          pushRemoval(changes, sessionAgentId, record);
          continue;
        }

        if (record.phase !== "working") {
          continue;
        }

        const progressed = await this.progressWorkingEpoch(session, record);
        if (!progressed) continue;
        next.sessions[sessionAgentId] = progressed.record;
        changes.push(...progressed.changes);
        changed = true;
      }

      return changed
        ? { value: undefined, state: next, changes }
        : { value: undefined };
    }));
  }

  /**
   * Runtime/lifecycle producer entry point. Only a real non-streaming ->
   * streaming transition from the manager or an owned worker can arm an epoch.
   */
  async observeStatus(observation: SessionAttentionStatusObservation): Promise<void> {
    await this.runNatural(async () => this.applyMutation(async (state) => {
      const sessionAgentId = observation.manager.agentId;
      if (observation.source === "manager" && observation.agentId !== sessionAgentId) {
        return { value: undefined };
      }

      if (!this.sessionIsEligible(observation)) {
        return retireFromState(state, sessionAgentId);
      }

      const current = state.sessions[sessionAgentId];
      const entersStreaming = observation.previousStatus !== "streaming" && observation.nextStatus === "streaming";
      if (entersStreaming) {
        if (current?.phase === "working") {
          // The continuation actually began, which is the only authoritative
          // release for the accepted-turn barrier. Same epoch continues.
          if (!current.awaitingContinuation) return { value: undefined };
          const resumed = cloneSessionAttentionState(state);
          const record = { ...current };
          delete record.awaitingContinuation;
          const progressed = await this.progressWorkingEpoch(observation, record);
          if (progressed) {
            resumed.sessions[sessionAgentId] = progressed.record;
            return { value: undefined, state: resumed, changes: progressed.changes };
          }
          resumed.sessions[sessionAgentId] = record;
          return { value: undefined, state: resumed, changes: [] };
        }
        const started = startEpoch(state, observation, observation.transitionedAt);
        const startedRecord = started.state?.sessions[sessionAgentId];
        if (!started.state || !startedRecord) return started;
        const progressed = await this.progressWorkingEpoch(observation, startedRecord);
        if (!progressed) return started;
        started.state.sessions[sessionAgentId] = progressed.record;
        return {
          value: undefined,
          state: started.state,
          changes: [...(started.changes ?? []), ...progressed.changes],
        };
      }

      if (!current || current.phase !== "working") {
        return { value: undefined };
      }

      const next = cloneSessionAttentionState(state);
      let record = next.sessions[sessionAgentId];
      let changed = false;
      if (observation.nextStatus === "error" && !record.hadError) {
        record = { ...record, hadError: true };
        next.sessions[sessionAgentId] = record;
        changed = true;
      }

      // Latch the barrier here too: a status observation carrying a queued
      // accepted turn must not later be settled by a bare count-to-zero.
      if (normalizeCount(observation.pendingTurnContextCount) > 0 && !record.awaitingContinuation) {
        record = { ...record, awaitingContinuation: true };
        next.sessions[sessionAgentId] = record;
        changed = true;
      }

      const progressed = await this.progressWorkingEpoch(observation, record);
      if (!progressed) {
        return changed ? { value: undefined, state: next, changes: [] } : { value: undefined };
      }
      next.sessions[sessionAgentId] = progressed.record;
      return { value: undefined, state: next, changes: progressed.changes };
    }));
  }

  /**
   * Choice, worker-ownership, and accepted-turn-queue producers call this only
   * after their own committed mutation. It cannot arm an epoch, but a newly
   * pending choice on an already armed epoch raises decision_waiting immediately.
   */
  async observeAggregateChange(session: SessionAttentionSessionSnapshot): Promise<void> {
    await this.runNatural(async () => this.applyMutation(async (state, context) => {
      const sessionAgentId = session.manager.agentId;
      if (!this.sessionIsEligible(session)) {
        return retireFromState(state, sessionAgentId);
      }

      const current = state.sessions[sessionAgentId];
      if (
        context.coalescingPending
        && current?.phase === "settled"
        && !isReadyToSettle(session)
      ) {
        // A newer aggregate fact invalidates an undurable settle. Restore the
        // working epoch directly so the retry never publishes stale attention.
        const next = cloneSessionAttentionState(state);
        const restored: PersistedSessionAttentionRecord = {
          ...current,
          phase: "working",
          ...(normalizeCount(session.pendingTurnContextCount) > 0
            ? { awaitingContinuation: true }
            : {}),
        };
        delete restored.attention;
        next.sessions[sessionAgentId] = restored;
        return { value: undefined, state: next, changes: [] };
      }
      if (!current || current.phase !== "working") {
        return { value: undefined };
      }

      // Latch the barrier for this epoch the first time an accepted turn is
      // seen queued, so a later drop to zero cannot be read as permission.
      if (normalizeCount(session.pendingTurnContextCount) > 0) {
        if (current.awaitingContinuation) return { value: undefined };
        const latched = cloneSessionAttentionState(state);
        latched.sessions[sessionAgentId] = { ...current, awaitingContinuation: true };
        return { value: undefined, state: latched, changes: [] };
      }

      const progressed = await this.progressWorkingEpoch(session, current);
      if (!progressed) {
        return { value: undefined };
      }
      const next = cloneSessionAttentionState(state);
      next.sessions[sessionAgentId] = progressed.record;
      return { value: undefined, state: next, changes: progressed.changes };
    }));
  }

  /**
   * Explicit no-continuation release for the accepted-turn barrier: the turn
   * ended without producing a continuation (rollback, discard, failure), so the
   * epoch may settle again on its own merits. Without this, a dequeued turn that
   * never streams would leave the epoch armed forever and miss the raise.
   */
  async releaseContinuationBarrier(session: SessionAttentionSessionSnapshot): Promise<void> {
    await this.runNatural(async () => this.applyMutation(async (state) => {
      const sessionAgentId = session.manager.agentId;
      if (!this.sessionIsEligible(session)) {
        return retireFromState(state, sessionAgentId);
      }

      const current = state.sessions[sessionAgentId];
      if (!current || current.phase !== "working") {
        return { value: undefined };
      }

      // A rollback can remove one accepted turn while another remains queued.
      // Never clear the epoch fence until the authoritative queue is empty.
      if (normalizeCount(session.pendingTurnContextCount) > 0) {
        if (current.awaitingContinuation) return { value: undefined };
        const latched = cloneSessionAttentionState(state);
        latched.sessions[sessionAgentId] = { ...current, awaitingContinuation: true };
        return { value: undefined, state: latched, changes: [] };
      }

      if (!current.awaitingContinuation) {
        return { value: undefined };
      }

      const cleared = cloneSessionAttentionState(state);
      const record = { ...current };
      delete record.awaitingContinuation;
      cleared.sessions[sessionAgentId] = record;

      const progressed = await this.progressWorkingEpoch(session, record);
      if (!progressed) {
        return { value: undefined, state: cleared, changes: [] };
      }
      cleared.sessions[sessionAgentId] = progressed.record;
      return { value: undefined, state: cleared, changes: progressed.changes };
    }));
  }

  /** Manual stop/recycle entry point: discard only an in-flight epoch. */
  async suppressWorkingEpoch(sessionAgentId: string): Promise<void> {
    await this.runNatural(async () => this.applyMutation(async (state, context) => {
      const current = state.sessions[sessionAgentId];
      if (
        !current
        || (current.phase !== "working" && !context.coalescingPending)
      ) return { value: undefined };
      const next = cloneSessionAttentionState(state);
      delete next.sessions[sessionAgentId];
      return { value: undefined, state: next, changes: [] };
    }));
  }

  /** Archive/delete/eligibility-loss lifecycle entry point. Restore stays unarmed. */
  async retireSession(sessionAgentId: string): Promise<void> {
    await this.runNatural(async () => this.applyMutation(async (state) => retireFromState(state, sessionAgentId)));
  }

  /** Instance-exact and serialized, so duplicate/concurrent clients converge. */
  async dismissAttentionIds(attentionIds: readonly string[]): Promise<SessionAttentionDismissResult> {
    return this.enqueue(async () => this.applyMutation(async (state) => {
      const requested = new Set(attentionIds);
      if (requested.size === 0) {
        return { value: { revision: state.revision, changes: [] } };
      }

      const next = cloneSessionAttentionState(state);
      const changes: SessionAttentionChange[] = [];
      for (const sessionAgentId of Object.keys(next.sessions).sort()) {
        const record = next.sessions[sessionAgentId];
        const attention = record.attention;
        if (!attention || attention.dismissedAt || !requested.has(attention.attentionId)) {
          continue;
        }

        next.sessions[sessionAgentId] = {
          ...record,
          attention: { ...attention, dismissedAt: this.now() },
        };
        changes.push({ sessionAgentId, attention: null });
      }

      if (changes.length === 0) {
        return { value: { revision: state.revision, changes } };
      }

      return {
        value: { revision: state.revision + 1, changes },
        state: next,
        changes,
      };
    }, { retryOnFailure: false }));
  }

  /** Durable, visible projection only; an undurable pending write is never exposed. */
  getSnapshot(): SessionAttentionCoordinatorSnapshot {
    this.assertInitialized();
    return { revision: this.state.revision, attentions: visibleAttentions(this.state) };
  }

  /**
   * A pending present_choices is itself a user-attention edge: the manager can
   * still read streaming because the tool is open, but the turn is waiting.
   * Raise decision_waiting on an armed epoch, retract it if work continues after
   * the answer, and only then allow a full quiescence settle.
   */
  private async progressWorkingEpoch(
    session: SessionAttentionSessionSnapshot,
    record: PersistedSessionAttentionRecord,
  ): Promise<{ record: PersistedSessionAttentionRecord; changes: SessionAttentionChange[] } | undefined> {
    if (record.awaitingContinuation) return undefined;

    const sessionAgentId = session.manager.agentId;
    if (hasPendingChoice(session)) {
      // Already raised or explicitly dismissed for this epoch. Do not mint a
      // second instance for the same still-pending choice.
      if (record.attention) return undefined;
      const nextRecord: PersistedSessionAttentionRecord = {
        ...record,
        attention: this.createAttention("decision_waiting"),
      };
      return {
        record: nextRecord,
        changes: [{ sessionAgentId, attention: toAttention(sessionAgentId, nextRecord)! }],
      };
    }

    if (!isReadyToSettle(session)) {
      const visible = toAttention(sessionAgentId, record);
      if (visible?.reason !== "decision_waiting") return undefined;
      const retracted = { ...record };
      delete retracted.attention;
      return {
        record: retracted,
        changes: [{ sessionAgentId, attention: null }],
      };
    }

    const settled = await this.settledRecord(session, record);
    return {
      record: settled,
      changes: [{ sessionAgentId, attention: toAttention(sessionAgentId, settled)! }],
    };
  }

  private async settledRecord(
    session: SessionAttentionSessionSnapshot,
    record: PersistedSessionAttentionRecord,
  ): Promise<PersistedSessionAttentionRecord> {
    const reason = record.hadError || session.hasTerminallyErroredWorker
      ? "work_failed"
      : await this.resolveReason({
        sessionAgentId: session.manager.agentId,
        profileId: record.profileId,
        workStartedAt: record.workStartedAt,
        hadError: false,
      });

    return {
      ...record,
      phase: "settled",
      attention: this.createAttention(reason),
    };
  }

  private createAttention(reason: SessionAttentionReason): PersistedSessionAttention {
    const attentionId = this.randomId();
    if (!isOpaqueId(attentionId)) {
      throw new Error("Session attention ID generator returned an invalid ID");
    }
    return {
      attentionId,
      reason,
      raisedAt: this.now(),
    };
  }

  private async resolveReason(input: SessionAttentionReasonInput): Promise<SessionAttentionReason> {
    try {
      const candidate = await this.getReason(input);
      return isReason(candidate) ? candidate : "work_settled";
    } catch (error) {
      this.log("session-attention:reason_provider_failed", {
        sessionAgentId: input.sessionAgentId,
        message: errorMessage(error),
      });
      return "work_settled";
    }
  }

  private sessionIsEligible(session: SessionAttentionSessionSnapshot): boolean {
    return this.isEligible({ manager: session.manager, profile: session.profile });
  }

  private async applyMutation<T>(
    mutate: (
      state: PersistedSessionAttentionState,
      context: MutationContext,
    ) => Promise<StateMutation<T>>,
    // Natural observations may be retried on the next operation because the
    // runtime fact they record is still true. A COMMAND must not: a dismissal
    // that reported failure to one device must never be applied later without
    // correlation, or another device sees an unexplained removal.
    options: { retryOnFailure: boolean } = { retryOnFailure: true },
  ): Promise<T> {
    this.assertInitialized();

    // Commands require the exact durable/published state before correlation.
    // Natural observations may supersede a failed natural target, so fold the
    // latest committed fact into that target before retrying. This prevents a
    // failed settle followed by new streaming from briefly publishing stale
    // settled attention on the retry.
    if (this.pendingCommit) {
      if (!options.retryOnFailure) {
        await this.flushPendingCommit();
      } else {
        const pending = this.pendingCommit;
        const mutation = await mutate(pending.state, { coalescingPending: true });
        if (!mutation.state) {
          await this.flushPendingCommit();
          return mutation.value;
        }

        const coalesced: PersistedSessionAttentionState = {
          ...mutation.state,
          revision: pending.state.revision,
        };
        this.pendingCommit = {
          state: coalesced,
          changes: diffVisibleAttentions(this.state, coalesced),
        };
        await this.flushPendingCommit();
        return mutation.value;
      }
    }

    const mutation = await mutate(this.state, { coalescingPending: false });
    if (!mutation.state) {
      return mutation.value;
    }

    const baseRevision = this.state.revision;
    if (!Number.isSafeInteger(baseRevision) || baseRevision + 1 <= baseRevision) {
      throw new Error("Session attention revision overflow; refusing to break monotonicity");
    }

    const next: PersistedSessionAttentionState = {
      ...mutation.state,
      revision: baseRevision + 1,
    };
    const changes = mutation.changes ?? [];
    try {
      await this.store.save(next);
    } catch (error) {
      if (options.retryOnFailure) {
        this.pendingCommit = { state: next, changes };
      }
      throw error;
    }

    this.commitDurable(next, changes);
    return mutation.value;
  }

  private async flushPendingCommit(): Promise<void> {
    const pending = this.pendingCommit;
    if (!pending) return;

    await this.store.save(pending.state);
    this.pendingCommit = undefined;
    this.commitDurable(pending.state, pending.changes);
  }

  private commitDurable(state: PersistedSessionAttentionState, changes: SessionAttentionChange[]): void {
    this.state = state;
    if (changes.length === 0) return;
    try {
      this.onChange({ revision: state.revision, changes, attentions: visibleAttentions(state) });
    } catch (error) {
      this.log("session-attention:change_listener_failed", {
        message: errorMessage(error),
      });
    }
  }

  private async runNatural(operation: () => Promise<void>): Promise<void> {
    try {
      await this.enqueue(operation);
    } catch (error) {
      // Attention must not stall runtimes. The failed target remains queued for
      // a bounded retry by the next coordinator mutation and was not published.
      this.log("session-attention:failed_to_persist", {
        path: this.store.filePath,
        message: errorMessage(error),
      });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("SessionAttentionCoordinator must be initialized before use");
    }
  }
}

function startEpoch(
  state: PersistedSessionAttentionState,
  session: SessionAttentionSessionSnapshot,
  workStartedAt: string,
): StateMutation<void> {
  const sessionAgentId = session.manager.agentId;
  const previous = state.sessions[sessionAgentId];
  const profileId = session.manager.profileId;
  if (!profileId) {
    return { value: undefined };
  }

  const next = cloneSessionAttentionState(state);
  next.sessions[sessionAgentId] = {
    profileId,
    epoch: (previous?.epoch ?? 0) + 1,
    phase: "working",
    workStartedAt,
  };
  const changes: SessionAttentionChange[] = [];
  if (previous) {
    pushRemoval(changes, sessionAgentId, previous);
  }
  return { value: undefined, state: next, changes };
}

function retireFromState(
  state: PersistedSessionAttentionState,
  sessionAgentId: string,
): StateMutation<void> {
  const current = state.sessions[sessionAgentId];
  if (!current) return { value: undefined };

  const next = cloneSessionAttentionState(state);
  delete next.sessions[sessionAgentId];
  const changes: SessionAttentionChange[] = [];
  pushRemoval(changes, sessionAgentId, current);
  return { value: undefined, state: next, changes };
}

function visibleAttentions(state: PersistedSessionAttentionState): SessionAttention[] {
  return Object.entries(state.sessions)
    .flatMap(([sessionAgentId, record]) => {
      const attention = toAttention(sessionAgentId, record);
      return attention ? [attention] : [];
    })
    .sort((left, right) => left.sessionAgentId.localeCompare(right.sessionAgentId));
}

function hasPendingChoice(session: SessionAttentionSessionSnapshot): boolean {
  return normalizeCount(session.pendingChoiceCount) > 0;
}

function isReadyToSettle(session: SessionAttentionSessionSnapshot): boolean {
  return session.manager.status === "idle"
    && normalizeCount(session.activeWorkerCount) === 0
    && !hasPendingChoice(session)
    && normalizeCount(session.pendingTurnContextCount) === 0;
}

function normalizeCount(value: number): number {
  // A malformed aggregate read must block rather than manufacture a settle.
  if (!Number.isFinite(value) || value < 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(value);
}

function toAttention(
  sessionAgentId: string,
  record: PersistedSessionAttentionRecord,
): SessionAttention | undefined {
  const attention = record.attention;
  if (!attention || attention.dismissedAt) return undefined;
  return {
    attentionId: attention.attentionId,
    sessionAgentId,
    profileId: record.profileId,
    reason: attention.reason,
    raisedAt: attention.raisedAt,
  };
}

function diffVisibleAttentions(
  previous: PersistedSessionAttentionState,
  next: PersistedSessionAttentionState,
): SessionAttentionChange[] {
  const changes: SessionAttentionChange[] = [];
  const sessionAgentIds = new Set([
    ...Object.keys(previous.sessions),
    ...Object.keys(next.sessions),
  ]);
  for (const sessionAgentId of [...sessionAgentIds].sort()) {
    const previousRecord = previous.sessions[sessionAgentId];
    const nextRecord = next.sessions[sessionAgentId];
    const previousAttention = previousRecord
      ? toAttention(sessionAgentId, previousRecord)
      : undefined;
    const nextAttention = nextRecord
      ? toAttention(sessionAgentId, nextRecord)
      : undefined;
    if (sameAttention(previousAttention, nextAttention)) continue;
    changes.push({ sessionAgentId, attention: nextAttention ?? null });
  }
  return changes;
}

function sameAttention(
  left: SessionAttention | undefined,
  right: SessionAttention | undefined,
): boolean {
  return left?.attentionId === right?.attentionId
    && left?.sessionAgentId === right?.sessionAgentId
    && left?.profileId === right?.profileId
    && left?.reason === right?.reason
    && left?.raisedAt === right?.raisedAt;
}

function pushRemoval(
  changes: SessionAttentionChange[],
  sessionAgentId: string,
  record: PersistedSessionAttentionRecord,
): void {
  if (toAttention(sessionAgentId, record)) {
    changes.push({ sessionAgentId, attention: null });
  }
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isReason(value: unknown): value is SessionAttentionReason {
  return value === "work_settled"
    || value === "plan_completed"
    || value === "work_graph_completed"
    || value === "awaiting_review"
    || value === "decision_waiting"
    || value === "work_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
