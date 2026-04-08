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
    const reconciledPairs: Array<{ interruptedRunId: string; requeuedRunId: string; sessionAgentId: string | null }> = [];

    for (const stored of interruptedRuns) {
      const requeuedRunId = createCortexReviewRunId();

      await appendCortexReviewRun(this.options.config.paths.dataDir, {
        ...stored,
        interruptedAt: reconciledAt,
        interruptionReason,
      });

      await appendCortexReviewRun(this.options.config.paths.dataDir, {
        runId: requeuedRunId,
        trigger: stored.trigger,
        scope: stored.scope,
        scopeLabel: stored.scopeLabel,
        requestText: stored.requestText,
        requestedAt: reconciledAt,
        sessionAgentId: null,
        sourceContext: stored.sourceContext ?? { channel: "web" },
        scheduleName: stored.scheduleName ?? null,
      });

      reconciledPairs.push({
        interruptedRunId: stored.runId,
        requeuedRunId,
        sessionAgentId: stored.sessionAgentId,
      });
    }

    console.warn(`[swarm][${reconciledAt}] cortex:review_runs:reconciled_interrupted`, {
      count: reconciledPairs.length,
      runs: reconciledPairs,
    });
  }

  async listReviewRuns(): Promise<CortexReviewRunRecord[]> {
    if (!this.options.config.cortexEnabled) {
      return [];
    }

    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const queuedRunIdsByPosition = new Map<string, number>();

    storedRuns
      .filter((stored) => !stored.blockedReason && !stored.sessionAgentId)
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
          (stored) => !stored.blockedReason && !stored.interruptedAt && !stored.sessionAgentId && stored.scope.mode === "all",
        );

        if (queuedAllScopeRun) {
          this.options.logDebug("cortex:review_run:coalesced", {
            reason: "all-scope run already queued",
            existingRunId: queuedAllScopeRun.runId,
          });
          return;
        }

        const activeReviewSession = this.getActiveReviewSession();
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

    const label = queuedRun.scope.mode === "all"
      ? "Review Run · Full Queue"
      : `Review Run · ${queuedRun.scope.profileId}/${queuedRun.scope.sessionId}`;

    const { sessionAgent } = await this.options.createSession(CORTEX_PROFILE_ID, {
      label,
      sessionPurpose: "cortex_review",
    });

    await appendCortexReviewRun(this.options.config.paths.dataDir, {
      ...queuedRun,
      sessionAgentId: sessionAgent.agentId,
      sourceContext: queuedRun.sourceContext ?? { channel: "web" },
    });

    await this.options.handleUserMessage(queuedRun.requestText, {
      targetAgentId: sessionAgent.agentId,
      sourceContext: queuedRun.sourceContext ?? { channel: "web" },
    });

    return this.getReviewRunByIdOrThrow(queuedRun.runId);
  }

  private async findNextQueuedReviewRun(): Promise<StoredCortexReviewRun | null> {
    const storedRuns = await readStoredCortexReviewRuns(this.options.config.paths.dataDir);
    const nextQueued = storedRuns
      .slice()
      .reverse()
      .find((stored) => !stored.blockedReason && !stored.sessionAgentId);

    return nextQueued ?? null;
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
