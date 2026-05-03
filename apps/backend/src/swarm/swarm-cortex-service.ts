import type {
  CortexReviewRunRecord,
  CortexReviewRunScope,
  CortexReviewRunTrigger,
} from "@forge/protocol";
import {
  appendCortexReviewRun,
  buildCortexReviewRunRequestText,
  buildCortexReviewRunScopeLabel,
  buildLiveCortexReviewRunRecord,
  createCortexReviewRunId,
  deriveLiveStatus,
  parseCortexReviewRunScopeFromText,
  parseScheduledTaskEnvelope,
  readStoredCortexReviewRuns,
  updateCortexReviewRuns,
  type StoredCortexReviewRun,
} from "./cortex-review-runs.js";
import { scanCortexReviewStatus } from "./scripts/cortex-scan.js";
import type {
  AgentDescriptor,
  AgentStatus,
  ConversationEntryEvent,
  MessageSourceContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from "./types.js";
import type { SwarmAgentRuntime } from "./runtime-contracts.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import { analyzeLatestCortexCloseoutNeed } from "./swarm-manager-utils.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const CORTEX_REVIEW_RUN_QUEUE_RETRY_MS = 250;
const CORTEX_REVIEW_DISPATCH_FAILURE_BLOCK_THRESHOLD = 3;
const CORTEX_USER_CLOSEOUT_REMINDER_MESSAGE = `SYSTEM: Before ending this direct review, publish a concise speak_to_user closeout. State the reviewed scope, whether anything was promoted, which files changed (or NONE), and whether follow-up remains. Report changed files as paths relative to the active data dir only — never absolute host paths. If exact files are uncertain, prefer NONE over guessing. Do this even for a no-op review.`;

export interface SwarmCortexServiceOptions {
  config: SwarmConfig;
  now: () => string;
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  getWorkersForManager: (managerId: string) => AgentDescriptor[];
  getConversationHistory: (agentId: string) => ConversationEntryEvent[];
  createSession: (
    profileId: string,
    options?: { label?: string; name?: string; sessionPurpose?: AgentDescriptor["sessionPurpose"] },
  ) => Promise<{ sessionAgent: AgentDescriptor }>;
  handleUserMessage: (
    text: string,
    options?: {
      targetAgentId?: string;
      sourceContext?: MessageSourceContext;
    },
  ) => Promise<void>;
  ensureCortexProfile: () => Promise<void>;
  sendMessage: (
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: { origin?: "user" | "internal" },
  ) => Promise<SendMessageReceipt>;
  logDebug: (message: string, details?: unknown) => void;
}

export class SwarmCortexService {
  private reviewRunStartMutex: Promise<void> = Promise.resolve();
  private reviewRunQueueTimer: NodeJS.Timeout | null = null;
  private readonly lastCloseoutReminderUserTimestampByAgentId = new Map<string, number>();
  private readonly closeoutReminderTimersByAgentId = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: SwarmCortexServiceOptions) {}

  isCortexRootInteractiveSession(descriptor: AgentDescriptor): boolean {
    return (
      descriptor.role === "manager" &&
      descriptor.agentId === CORTEX_PROFILE_ID &&
      descriptor.profileId === CORTEX_PROFILE_ID &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID &&
      descriptor.sessionPurpose !== "cortex_review" &&
      descriptor.sessionPurpose !== "agent_creator"
    );
  }

  async reconcileInterruptedReviewRunsForBoot(): Promise<void> {
    if (!this.options.config.cortexEnabled) {
      return;
    }

    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const interruptedRuns = storedRuns
      .slice()
      .reverse()
      .filter((stored) => {
        if (!stored.sessionAgentId) {
          return false;
        }

        const sessionDescriptor = this.options.descriptors.get(stored.sessionAgentId);
        const activeWorkerCount = this.options.getWorkersForManager(stored.sessionAgentId)
          .filter((worker) => worker.status === "streaming")
          .length;

        return deriveLiveStatus(stored, sessionDescriptor, activeWorkerCount) === "running";
      });

    if (interruptedRuns.length === 0) {
      return;
    }

    const reconciledAt = this.options.now();
    const interruptionReason = "Interrupted by backend restart; request requeued automatically.";
    const requeueReason = "backend_restart";
    const pairByInterruptedRunId = new Map<string, string>();
    const reconciledPairs: Array<{ interruptedRunId: string; requeuedRunId: string; sessionAgentId: string | null }> = [];

    for (const stored of interruptedRuns) {
      const requeuedRunId = createCortexReviewRunId();
      pairByInterruptedRunId.set(stored.runId, requeuedRunId);
      reconciledPairs.push({
        interruptedRunId: stored.runId,
        requeuedRunId,
        sessionAgentId: stored.sessionAgentId,
      });
    }

    await updateCortexReviewRuns(this.options.config.paths.dataDir, (runs) => {
      const nextRuns = runs.map((run) => {
        const successorRunId = pairByInterruptedRunId.get(run.runId);
        if (!successorRunId) {
          return run;
        }
        return {
          ...run,
          interruptedAt: reconciledAt,
          interruptionReason,
          successorRunId,
          requeueReason,
        };
      });

      const replacements = interruptedRuns.map((stored) => ({
        runId: pairByInterruptedRunId.get(stored.runId)!,
        trigger: stored.trigger,
        scope: stored.scope,
        scopeLabel: stored.scopeLabel,
        requestText: stored.requestText,
        requestedAt: reconciledAt,
        sessionAgentId: null,
        sourceContext: stored.sourceContext ?? { channel: "web" },
        scheduleName: stored.scheduleName ?? null,
        dispatchState: "queued" as const,
        predecessorRunId: stored.runId,
        requeueReason,
      }));

      return [...replacements, ...nextRuns];
    });

    console.warn(`[swarm][${reconciledAt}] cortex:review_runs:reconciled_interrupted`, {
      count: reconciledPairs.length,
      runs: reconciledPairs,
    });
  }

  async recoverIncompleteReviewRunDispatchesForBoot(): Promise<void> {
    if (!this.options.config.cortexEnabled) {
      return;
    }

    await this.attachMarkerBearingOrphanReviewSessions();

    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    for (const run of storedRuns.slice().reverse()) {
      if (run.blockedReason || run.interruptedAt || run.dispatchState !== "session_created") {
        continue;
      }

      if (!run.sessionAgentId || !this.options.descriptors.has(run.sessionAgentId)) {
        await updateCortexReviewRuns(this.options.config.paths.dataDir, (runs) => runs.map((entry) =>
          entry.runId === run.runId
            ? { ...entry, sessionAgentId: null, dispatchState: "queued", dispatchStartedAt: null }
            : entry,
        ));
        continue;
      }

      const descriptor = this.options.descriptors.get(run.sessionAgentId);
      const hasStreamingWork = descriptor?.status === "streaming" || this.options.getWorkersForManager(run.sessionAgentId).some((worker) => worker.status === "streaming");
      if (hasStreamingWork) {
        this.options.logDebug("cortex:review_dispatch:session_created_streaming", {
          runId: run.runId,
          sessionAgentId: run.sessionAgentId,
        });
        continue;
      }

      try {
        await this.dispatchReviewRunRequest(run);
        await appendCortexReviewRun(this.options.config.paths.dataDir, {
          ...run,
          dispatchState: "dispatched",
          dispatchedAt: this.options.now(),
          dispatchFailureCount: null,
          sourceContext: run.sourceContext ?? { channel: "web" },
        });
      } catch (error) {
        await this.returnRunToQueueAfterDispatchFailure(run.runId, error);
      }
    }
  }

  async listReviewRuns(): Promise<CortexReviewRunRecord[]> {
    if (!this.options.config.cortexEnabled) {
      return [];
    }

    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const queuedRunIdsByPosition = new Map<string, number>();

    storedRuns
      .filter((stored) => !stored.blockedReason && !stored.interruptedAt && (stored.dispatchState ?? (stored.sessionAgentId ? "dispatched" : "queued")) === "queued" && !stored.sessionAgentId)
      .slice()
      .reverse()
      .forEach((stored, index) => {
        queuedRunIdsByPosition.set(stored.runId, index + 1);
      });

    return storedRuns.map((stored) => {
      const sessionDescriptor = stored.sessionAgentId
        ? this.options.descriptors.get(stored.sessionAgentId)
        : undefined;
      const activeWorkerCount = stored.sessionAgentId
        ? this.options.getWorkersForManager(stored.sessionAgentId).filter((worker) => worker.status === "streaming").length
        : 0;

      return buildLiveCortexReviewRunRecord({
        stored,
        sessionDescriptor,
        activeWorkerCount,
        history: stored.sessionAgentId ? this.options.getConversationHistory(stored.sessionAgentId) : [],
        queuePosition: queuedRunIdsByPosition.get(stored.runId) ?? null,
      });
    });
  }

  async startReviewRun(input: {
    scope: CortexReviewRunScope;
    trigger: CortexReviewRunTrigger;
    sourceContext?: MessageSourceContext;
    requestText?: string;
    scheduleName?: string | null;
  }): Promise<CortexReviewRunRecord | null> {
    if (!this.options.config.cortexEnabled) {
      return null;
    }

    const runId = createCortexReviewRunId();
    let startedRunId: string | null = null;

    await this.withReviewRunStartLock(async () => {
      if (input.trigger === "scheduled" && input.scope.mode === "all") {
        const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
        const queuedAllScopeRun = storedRuns.find(
          (stored) =>
            !stored.blockedReason &&
            !stored.interruptedAt &&
            (stored.dispatchState ?? (stored.sessionAgentId ? "dispatched" : "queued")) !== "dispatched" &&
            stored.scope.mode === "all",
        );

        if (queuedAllScopeRun) {
          this.options.logDebug("cortex:review_run:coalesced", {
            reason: "all-scope run already queued",
            existingRunId: queuedAllScopeRun.runId,
          });
          return;
        }

        const activeReviewSession = await this.getActiveOrReservedReviewSession();
        if (activeReviewSession) {
          const activeAllScopeRun = storedRuns.find(
            (stored) =>
              !stored.blockedReason &&
              !stored.interruptedAt &&
              stored.sessionAgentId === activeReviewSession.agentId &&
              stored.scope.mode === "all",
          );

          if (activeAllScopeRun) {
            this.options.logDebug("cortex:review_run:coalesced", {
              reason: "all-scope run already active",
              activeRunId: activeAllScopeRun.runId,
            });
            return;
          }
        }
      }

      await this.options.ensureCortexProfile();

      await appendCortexReviewRun(this.options.config.paths.dataDir, {
        runId,
        trigger: input.trigger,
        scope: input.scope,
        scopeLabel: buildCortexReviewRunScopeLabel(input.scope),
        requestText: input.requestText?.trim() || buildCortexReviewRunRequestText(input.scope),
        requestedAt: this.options.now(),
        sessionAgentId: null,
        dispatchState: "queued",
        sourceContext: input.sourceContext ?? { channel: "web" },
        scheduleName: input.scheduleName ?? null,
      });

      startedRunId = runId;
      await this.startNextQueuedReviewRun();
    });

    if (!startedRunId) {
      return null;
    }

    this.scheduleReviewRunQueueCheck();
    return this.getReviewRunByIdOrThrow(startedRunId);
  }

  async maybeStartReviewRunFromIncomingMessage(
    text: string,
    target: AgentDescriptor,
    sourceContext: MessageSourceContext,
  ): Promise<boolean> {
    if (!this.options.config.cortexEnabled) {
      return false;
    }

    if (!this.isCortexRootInteractiveSession(target)) {
      return false;
    }

    const scheduledEnvelope = parseScheduledTaskEnvelope(text);
    const reviewText = scheduledEnvelope?.body ?? text;
    const scope = parseCortexReviewRunScopeFromText(reviewText);
    if (!scope) {
      return false;
    }

    const trigger: CortexReviewRunTrigger = scheduledEnvelope ? "scheduled" : "manual";
    if (trigger === "scheduled" && scope.mode === "all") {
      const scanResult = await scanCortexReviewStatus(this.options.config.paths.dataDir);
      if (scanResult.summary.needsReview === 0) {
        this.options.logDebug("cortex:auto_review:skipped", {
          reason: "nothing needs review",
          upToDate: scanResult.summary.upToDate,
          excluded: scanResult.summary.excluded,
          scheduleName: scheduledEnvelope?.scheduleName ?? null,
        });
        return true;
      }
    }

    await this.startReviewRun({
      scope,
      trigger,
      sourceContext,
      requestText: text.trim(),
      scheduleName: scheduledEnvelope?.scheduleName ?? null,
    });
    return true;
  }

  handleManagerStatusTransition(
    descriptor: AgentDescriptor,
    nextStatus: AgentStatus,
    pendingCount: number,
  ): void {
    if (descriptor.role !== "manager") {
      return;
    }

    if (nextStatus === "idle" && pendingCount === 0) {
      this.scheduleCloseoutReminder(descriptor.agentId);
      return;
    }

    this.clearCloseoutReminder(descriptor.agentId);
  }

  handleAgentStatusEvent(descriptor: AgentDescriptor | undefined, status: AgentStatus): void {
    const reviewSessionDescriptor = descriptor?.sessionPurpose === "cortex_review"
      ? descriptor
      : descriptor?.role === "worker"
        ? this.options.descriptors.get(descriptor.managerId)
        : undefined;

    if (reviewSessionDescriptor?.sessionPurpose === "cortex_review") {
      this.scheduleReviewRunQueueCheck(status === "streaming" ? CORTEX_REVIEW_RUN_QUEUE_RETRY_MS : 0);
    }
  }

  async resolveActiveReviewRunIdForDescriptor(descriptor: AgentDescriptor): Promise<string | undefined> {
    const sessionAgentId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
    if (!sessionAgentId) {
      return undefined;
    }

    try {
      const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
      return storedRuns.find((run) => run.sessionAgentId === sessionAgentId)?.runId;
    } catch (error) {
      this.options.logDebug("cortex:review_run:resolve_failed", {
        sessionAgentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  scheduleReviewRunQueueCheck(delayMs = CORTEX_REVIEW_RUN_QUEUE_RETRY_MS): void {
    if (!this.options.config.cortexEnabled) {
      this.clearReviewRunQueueCheck();
      return;
    }

    this.clearReviewRunQueueCheck();

    const timer = setTimeout(() => {
      this.reviewRunQueueTimer = null;
      void this.processReviewRunQueue().catch((error) => {
        this.options.logDebug("cortex:review_queue:error", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      });
    }, Math.max(0, delayMs));

    timer.unref?.();
    this.reviewRunQueueTimer = timer;
  }

  private async withReviewRunStartLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.reviewRunStartMutex;
    let release: (() => void) | undefined;
    this.reviewRunStartMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private getActiveReviewSession(): AgentDescriptor | undefined {
    return Array.from(this.options.descriptors.values()).find(
      (descriptor) =>
        descriptor.role === "manager" &&
        descriptor.profileId === CORTEX_PROFILE_ID &&
        descriptor.sessionPurpose === "cortex_review" &&
        (
          descriptor.status === "streaming" ||
          this.options.getWorkersForManager(descriptor.agentId).some((worker) => worker.status === "streaming")
        ),
    );
  }

  private async getActiveOrReservedReviewSession(): Promise<AgentDescriptor | undefined> {
    const activeReviewSession = this.getActiveReviewSession();
    if (activeReviewSession) {
      return activeReviewSession;
    }

    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const reservedRun = storedRuns.find(
      (run) => !run.blockedReason && !run.interruptedAt && run.dispatchState === "session_created" && run.sessionAgentId,
    );
    return reservedRun?.sessionAgentId ? this.options.descriptors.get(reservedRun.sessionAgentId) : undefined;
  }

  private async getReviewRunByIdOrThrow(runId: string): Promise<CortexReviewRunRecord> {
    const runs = await this.listReviewRuns();
    const run = runs.find((entry) => entry.runId === runId);
    if (!run) {
      throw new Error(`Unable to load Cortex review run ${runId}`);
    }
    return run;
  }

  private async startNextQueuedReviewRun(): Promise<CortexReviewRunRecord | null> {
    const activeReviewSession = this.getActiveReviewSession();
    if (activeReviewSession) {
      return null;
    }

    const queuedRun = await this.findNextQueuedReviewRun();
    if (!queuedRun) {
      this.clearReviewRunQueueCheck();
      return null;
    }

    let sessionAgentId = queuedRun.sessionAgentId;
    let dispatchStartedAt = queuedRun.dispatchStartedAt ?? this.options.now();

    if (sessionAgentId) {
      const existingDescriptor = this.options.descriptors.get(sessionAgentId);
      if (!existingDescriptor) {
        await updateCortexReviewRuns(this.options.config.paths.dataDir, (runs) => runs.map((run) =>
          run.runId === queuedRun.runId
            ? { ...run, sessionAgentId: null, dispatchState: "queued", dispatchStartedAt: null }
            : run,
        ));
        this.scheduleReviewRunQueueCheck(0);
        return null;
      }

      const hasStreamingWork =
        existingDescriptor.status === "streaming" ||
        this.options.getWorkersForManager(sessionAgentId).some((worker) => worker.status === "streaming");
      if (hasStreamingWork) {
        this.scheduleReviewRunQueueCheck();
        return null;
      }
    } else {
      const shortRunId = queuedRun.runId.slice(0, 12);
      const label = queuedRun.scope.mode === "all"
        ? `Review Run · Full Queue · ${shortRunId}`
        : `Review Run · ${queuedRun.scope.profileId}/${queuedRun.scope.sessionId} · ${shortRunId}`;

      const { sessionAgent } = await this.options.createSession(CORTEX_PROFILE_ID, {
        label,
        sessionPurpose: "cortex_review",
      });
      sessionAgentId = sessionAgent.agentId;
      dispatchStartedAt = this.options.now();
    }

    await appendCortexReviewRun(this.options.config.paths.dataDir, {
      ...queuedRun,
      sessionAgentId,
      dispatchState: "session_created",
      dispatchStartedAt,
      sourceContext: queuedRun.sourceContext ?? { channel: "web" },
    });

    try {
      await this.dispatchReviewRunRequest({ ...queuedRun, sessionAgentId });
    } catch (error) {
      await this.returnRunToQueueAfterDispatchFailure(queuedRun.runId, error);
      this.scheduleReviewRunQueueCheck();
      throw error;
    }

    await appendCortexReviewRun(this.options.config.paths.dataDir, {
      ...queuedRun,
      sessionAgentId,
      dispatchState: "dispatched",
      dispatchStartedAt,
      dispatchedAt: this.options.now(),
      dispatchFailureCount: null,
      sourceContext: queuedRun.sourceContext ?? { channel: "web" },
    });

    return this.getReviewRunByIdOrThrow(queuedRun.runId);
  }

  private async findNextQueuedReviewRun(): Promise<StoredCortexReviewRun | null> {
    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const nextQueued = storedRuns
      .slice()
      .reverse()
      .find(
        (stored) =>
          !stored.blockedReason &&
          !stored.interruptedAt &&
          ((stored.dispatchState ?? "queued") === "queued" || stored.dispatchState === "session_created"),
      );

    return nextQueued ?? null;
  }

  private async attachMarkerBearingOrphanReviewSessions(): Promise<void> {
    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const referencedSessionIds = new Set(storedRuns.map((run) => run.sessionAgentId).filter((value): value is string => typeof value === "string"));
    const queuedRunsById = new Map(
      storedRuns
        .filter((run) => !run.blockedReason && !run.interruptedAt && (run.dispatchState ?? "queued") === "queued" && !run.sessionAgentId)
        .map((run) => [run.runId, run]),
    );

    const attachments: Array<{ runId: string; sessionAgentId: string }> = [];
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "manager" || descriptor.profileId !== CORTEX_PROFILE_ID || descriptor.sessionPurpose !== "cortex_review") {
        continue;
      }
      if (referencedSessionIds.has(descriptor.agentId)) {
        continue;
      }

      const marker = `${descriptor.sessionLabel ?? descriptor.displayName ?? ""}`;
      const run = Array.from(queuedRunsById.values()).find((candidate) => marker.includes(candidate.runId.slice(0, 12)) || marker.includes(candidate.runId));
      if (!run) {
        this.options.logDebug("cortex:review_dispatch:orphan_session", {
          sessionAgentId: descriptor.agentId,
          label: descriptor.sessionLabel ?? descriptor.displayName,
        });
        continue;
      }
      attachments.push({ runId: run.runId, sessionAgentId: descriptor.agentId });
      queuedRunsById.delete(run.runId);
    }

    if (attachments.length === 0) {
      return;
    }

    const dispatchStartedAt = this.options.now();
    await updateCortexReviewRuns(this.options.config.paths.dataDir, (runs) => runs.map((run) => {
      const attachment = attachments.find((candidate) => candidate.runId === run.runId);
      return attachment
        ? { ...run, sessionAgentId: attachment.sessionAgentId, dispatchState: "session_created", dispatchStartedAt: run.dispatchStartedAt ?? dispatchStartedAt }
        : run;
    }));
  }

  private async dispatchReviewRunRequest(run: StoredCortexReviewRun): Promise<void> {
    if (!run.sessionAgentId) {
      throw new Error(`Cortex review run ${run.runId} has no review session to dispatch`);
    }

    await this.options.handleUserMessage(run.requestText, {
      targetAgentId: run.sessionAgentId,
      sourceContext: run.sourceContext ?? { channel: "web" },
    });
  }

  private async returnRunToQueueAfterDispatchFailure(runId: string, error: unknown): Promise<void> {
    this.options.logDebug("cortex:review_dispatch:error", {
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
    await updateCortexReviewRuns(this.options.config.paths.dataDir, (runs) => runs.map((run) => {
      if (run.runId !== runId) {
        return run;
      }

      const dispatchFailureCount = (run.dispatchFailureCount ?? 0) + 1;
      if (dispatchFailureCount >= CORTEX_REVIEW_DISPATCH_FAILURE_BLOCK_THRESHOLD) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...run,
          dispatchFailureCount,
          blockedReason: `Review dispatch failed ${dispatchFailureCount} times: ${message}`,
          dispatchState: "queued",
        };
      }

      return { ...run, dispatchFailureCount, dispatchState: "queued" };
    }));
  }

  private clearReviewRunQueueCheck(): void {
    if (!this.reviewRunQueueTimer) {
      return;
    }

    clearTimeout(this.reviewRunQueueTimer);
    this.reviewRunQueueTimer = null;
  }

  private async processReviewRunQueue(): Promise<void> {
    if (!this.options.config.cortexEnabled) {
      this.clearReviewRunQueueCheck();
      return;
    }

    await this.withReviewRunStartLock(async () => {
      const activeReviewSession = this.getActiveReviewSession();
      const queuedRun = await this.findNextQueuedReviewRun();

      if (!queuedRun) {
        this.clearReviewRunQueueCheck();
        return;
      }

      if (activeReviewSession) {
        this.scheduleReviewRunQueueCheck();
        return;
      }

      await this.options.ensureCortexProfile();
      await this.startNextQueuedReviewRun();
      this.scheduleReviewRunQueueCheck();
    });
  }

  private scheduleCloseoutReminder(agentId: string): void {
    this.clearCloseoutReminder(agentId);

    const timer = setTimeout(() => {
      this.closeoutReminderTimersByAgentId.delete(agentId);
      void this.maybeRemindCloseout(agentId);
    }, 250);

    this.closeoutReminderTimersByAgentId.set(agentId, timer);
  }

  private clearCloseoutReminder(agentId: string): void {
    const timer = this.closeoutReminderTimersByAgentId.get(agentId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.closeoutReminderTimersByAgentId.delete(agentId);
  }

  private async maybeRemindCloseout(agentId: string): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }
    if (normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID) {
      return;
    }
    if (descriptor.status !== "idle") {
      return;
    }

    const runtime = this.options.runtimes.get(agentId);
    if (runtime && runtime.getPendingCount() > 0) {
      return;
    }

    const analysis = analyzeLatestCortexCloseoutNeed(this.options.getConversationHistory(descriptor.agentId));
    if (!analysis.needsReminder || typeof analysis.userTimestamp !== "number") {
      return;
    }

    if (this.lastCloseoutReminderUserTimestampByAgentId.get(descriptor.agentId) === analysis.userTimestamp) {
      return;
    }

    try {
      await this.options.sendMessage(descriptor.agentId, descriptor.agentId, CORTEX_USER_CLOSEOUT_REMINDER_MESSAGE, "auto", {
        origin: "internal",
      });
      this.lastCloseoutReminderUserTimestampByAgentId.set(descriptor.agentId, analysis.userTimestamp);
      this.options.logDebug("cortex:closeout_reminder:sent", {
        agentId: descriptor.agentId,
        userTimestamp: analysis.userTimestamp,
        reason: analysis.reason,
      });
    } catch (error) {
      this.options.logDebug("cortex:closeout_reminder:error", {
        agentId: descriptor.agentId,
        userTimestamp: analysis.userTimestamp,
        reason: analysis.reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
