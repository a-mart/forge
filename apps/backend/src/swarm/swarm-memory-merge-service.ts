import { appendFile, readFile, writeFile } from "node:fs/promises";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type {
  SessionMemoryMergeAttemptStatus,
  SessionMemoryMergeFailureStage,
  SessionMemoryMergeResult,
  SessionMemoryMergeStrategy,
  SessionMeta
} from "@forge/protocol";
import type { VersioningMutation } from "../versioning/versioning-types.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { getProfileMemoryPath, getProfileMergeAuditLogPath } from "./data-paths.js";
import { executeLLMMerge, MEMORY_MERGE_SYSTEM_PROMPT } from "./memory-merge.js";
import { createPiModelRegistry } from "./pi-model-registry.js";
import type { PromptCategory } from "./prompt-registry.js";
import type { SessionMemoryMergeAttemptMetaUpdate } from "./swarm-session-meta-service.js";
import type { AgentDescriptor, SwarmConfig } from "./types.js";
import {
  errorToMessage,
  finalizeMergedMemoryContent,
  hashMemoryMergeContent,
  isPostApplyFailureStage,
  normalizeMemoryMergeContent,
  normalizeMemoryTemplateLines,
  normalizeOptionalAgentId,
  resolveModel
} from "./swarm-manager-utils.js";

const DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT = [
  "# Swarm Memory",
  "",
  "## User Preferences",
  "- (none yet)",
  "",
  "## Project Facts",
  "- (none yet)",
  "",
  "## Decisions",
  "- (none yet)",
  "",
  "## Open Follow-ups",
  "- (none yet)",
  ""
].join("\n");

const DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES = normalizeMemoryTemplateLines(
  DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT
);

export interface SessionMemoryMergeAuditEntry {
  attemptId: string;
  timestamp: string;
  sessionAgentId: string;
  profileId: string;
  status: SessionMemoryMergeAttemptStatus;
  strategy: SessionMemoryMergeStrategy;
  stage?: SessionMemoryMergeFailureStage;
  llmMergeSucceeded: boolean;
  usedFallbackAppend: boolean;
  appliedChange: boolean;
  model: string;
  sessionContentHash: string;
  profileContentHashBefore: string;
  profileContentHashAfter?: string;
  error?: string;
}

interface SessionMemoryMergeFailureContext {
  timestamp: string;
  attemptId: string;
  profileId: string;
  auditPath: string;
  stage: SessionMemoryMergeFailureStage;
  strategy?: SessionMemoryMergeStrategy;
  sessionContentHash?: string;
  profileContentHashBefore: string;
  profileContentHashAfter?: string;
  llmMergeSucceeded: boolean;
  model: string;
  appliedChange: boolean;
}

class SessionMemoryMergeFailure extends Error {
  readonly strategy?: SessionMemoryMergeStrategy;
  readonly stage: SessionMemoryMergeFailureStage;
  readonly auditPath: string;

  constructor(
    message: string,
    options: {
      strategy?: SessionMemoryMergeStrategy;
      stage: SessionMemoryMergeFailureStage;
      auditPath: string;
    }
  ) {
    super(message);
    this.name = "SessionMemoryMergeFailure";
    this.strategy = options.strategy;
    this.stage = options.stage;
    this.auditPath = options.auditPath;
  }
}

export interface SwarmMemoryMergeServiceOptions {
  config: SwarmConfig;
  now: () => string;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
  emitAgentsSnapshot: () => void;
  getRequiredSessionDescriptor: (
    agentId: string
  ) => AgentDescriptor & { role: "manager"; profileId: string };
  upsertDescriptor: (descriptor: AgentDescriptor) => void;
  getAgentMemoryPath: (agentId: string) => string;
  resolvePreferredManagerId: (options?: { includeStoppedOnRestart?: boolean }) => string | undefined;
  resolvePromptWithFallback: (
    category: PromptCategory,
    promptId: string,
    profileId: string | undefined,
    fallback: string
  ) => Promise<string>;
  ensureMemoryFilesForBoot: (options: {
    resolveMemoryTemplateContent: (profileId: string) => Promise<string>;
  }) => Promise<void>;
  ensureAgentMemoryFileInPersistence: (
    memoryFilePath: string,
    memoryTemplateContent: string
  ) => Promise<void>;
  readSessionMetaForDescriptor: (descriptor: AgentDescriptor) => Promise<SessionMeta | undefined>;
  writeSessionMemoryMergeAttemptMeta: (
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate
  ) => Promise<void>;
  recordSessionMemoryMergeAttempt: (
    descriptor: AgentDescriptor,
    attempt: {
      attemptId?: string | null;
      timestamp: string;
      status: SessionMemoryMergeAttemptStatus;
      strategy?: SessionMemoryMergeStrategy | null;
      failureStage?: SessionMemoryMergeFailureStage | null;
      sessionContentHash?: string | null;
      profileContentHashBefore?: string | null;
      profileContentHashAfter?: string | null;
      appliedSourceHash?: string | null;
      error?: string;
    }
  ) => Promise<void>;
  appendSessionMemoryMergeAuditEntry: (entry: SessionMemoryMergeAuditEntry) => Promise<void>;
  refreshSessionMetaStatsBySessionId: (sessionAgentId: string) => Promise<void>;
  queueVersioningMutation: (mutation: VersioningMutation) => void;
  resolveActiveCortexReviewRunIdForDescriptor: (
    descriptor: AgentDescriptor
  ) => Promise<string | undefined>;
  saveStore: () => Promise<void>;
  runSessionMemoryLLMMerge: (
    descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string
  ) => Promise<{ mergedContent: string; model: string }>;
  getPiModelsJsonPath: () => string;
}

export class SwarmMemoryMergeService {
  private readonly profileMergeMutexes = new Map<string, Promise<void>>();
  private defaultMemoryTemplateNormalizedLines = DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES;

  constructor(private readonly options: SwarmMemoryMergeServiceOptions) {}

  async refreshDefaultMemoryTemplateNormalizedLines(): Promise<void> {
    const memoryTemplate = await this.options.resolvePromptWithFallback(
      "operational",
      "memory-template",
      undefined,
      DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT
    );

    const normalizedLines = normalizeMemoryTemplateLines(memoryTemplate);
    if (normalizedLines.length === 0) {
      this.defaultMemoryTemplateNormalizedLines = DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES;
      return;
    }

    this.defaultMemoryTemplateNormalizedLines = normalizedLines;
  }

  async resolveMemoryTemplateContent(profileId: string): Promise<string> {
    return this.options.resolvePromptWithFallback(
      "operational",
      "memory-template",
      profileId,
      DEFAULT_MEMORY_TEMPLATE_FALLBACK_CONTENT
    );
  }

  async ensureMemoryFilesForBoot(): Promise<void> {
    await this.options.ensureMemoryFilesForBoot({
      resolveMemoryTemplateContent: (profileId) => this.resolveMemoryTemplateContent(profileId)
    });
  }

  async ensureAgentMemoryFile(memoryFilePath: string, profileId?: string): Promise<void> {
    const resolvedProfileId =
      normalizeOptionalAgentId(profileId) ??
      this.options.resolvePreferredManagerId({ includeStoppedOnRestart: true }) ??
      "default";
    const memoryTemplateContent = await this.resolveMemoryTemplateContent(resolvedProfileId);

    await this.options.ensureAgentMemoryFileInPersistence(memoryFilePath, memoryTemplateContent);
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    const descriptor = this.options.getRequiredSessionDescriptor(agentId);
    const profileId = descriptor.profileId ?? descriptor.agentId;
    if (descriptor.agentId === profileId) {
      throw new Error(`Default session working memory merge is not supported: ${agentId}`);
    }

    const releaseMergeLock = await this.acquireProfileMergeLock(profileId);

    const mergedAt = this.options.now();
    const attemptId = `${descriptor.agentId}:${mergedAt}`;
    const auditPath = getProfileMergeAuditLogPath(this.options.config.paths.dataDir, profileId);
    const failureContext: SessionMemoryMergeFailureContext = {
      timestamp: mergedAt,
      attemptId,
      profileId,
      auditPath,
      stage: "prepare",
      profileContentHashBefore: "",
      llmMergeSucceeded: false,
      model: `${descriptor.model.provider}/${descriptor.model.modelId}`,
      appliedChange: false
    };

    try {
      const sessionMemoryPath = this.options.getAgentMemoryPath(agentId);
      const profileMemoryPath = getProfileMemoryPath(this.options.config.paths.dataDir, profileId);

      await this.ensureAgentMemoryFile(sessionMemoryPath, profileId);
      await this.ensureAgentMemoryFile(profileMemoryPath, profileId);

      failureContext.stage = "read_inputs";
      const [sessionMemoryContent, profileMemoryContent, existingMeta] = await Promise.all([
        readFile(sessionMemoryPath, "utf8"),
        readFile(profileMemoryPath, "utf8"),
        this.options.readSessionMetaForDescriptor(descriptor)
      ]);

      const sessionContentHash = hashMemoryMergeContent(sessionMemoryContent);
      const profileContentHashBefore = hashMemoryMergeContent(profileMemoryContent);
      const lastAppliedAt = existingMeta?.lastMemoryMergeAppliedAt ?? descriptor.mergedAt;
      failureContext.sessionContentHash = sessionContentHash;
      failureContext.profileContentHashBefore = profileContentHashBefore;

      if (this.isSessionMemoryMergeNoOp(sessionMemoryContent)) {
        failureContext.strategy = "template_noop";
        failureContext.model = "noop";
        failureContext.profileContentHashAfter = profileContentHashBefore;
        failureContext.stage = "record_attempt";
        await this.options.recordSessionMemoryMergeAttempt(descriptor, {
          attemptId,
          timestamp: mergedAt,
          status: "skipped",
          strategy: "template_noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });
        failureContext.stage = "write_audit";
        await this.options.appendSessionMemoryMergeAuditEntry({
          attemptId,
          timestamp: mergedAt,
          sessionAgentId: descriptor.agentId,
          profileId,
          status: "skipped",
          strategy: "template_noop",
          llmMergeSucceeded: false,
          usedFallbackAppend: false,
          appliedChange: false,
          model: "noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });

        return {
          agentId: descriptor.agentId,
          status: "skipped",
          strategy: "template_noop",
          mergedAt: lastAppliedAt,
          auditPath
        };
      }

      if (
        this.shouldSkipSessionMemoryMergeIdempotently(
          existingMeta,
          sessionContentHash,
          profileContentHashBefore
        )
      ) {
        failureContext.strategy = "idempotent_noop";
        failureContext.model = "noop";
        failureContext.profileContentHashAfter = profileContentHashBefore;
        failureContext.stage = "record_attempt";
        await this.options.recordSessionMemoryMergeAttempt(descriptor, {
          attemptId,
          timestamp: mergedAt,
          status: "skipped",
          strategy: "idempotent_noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });
        failureContext.stage = "write_audit";
        await this.options.appendSessionMemoryMergeAuditEntry({
          attemptId,
          timestamp: mergedAt,
          sessionAgentId: descriptor.agentId,
          profileId,
          status: "skipped",
          strategy: "idempotent_noop",
          llmMergeSucceeded: false,
          usedFallbackAppend: false,
          appliedChange: false,
          model: "noop",
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });

        return {
          agentId: descriptor.agentId,
          status: "skipped",
          strategy: "idempotent_noop",
          mergedAt: lastAppliedAt,
          auditPath
        };
      }

      let mergedProfileMemory = finalizeMergedMemoryContent(profileMemoryContent);
      let llmMergeSucceeded = false;
      let mergeModel = "seed";
      let strategy: SessionMemoryMergeStrategy = "seed";
      failureContext.strategy = strategy;
      failureContext.model = mergeModel;

      if (normalizeMemoryMergeContent(profileMemoryContent).length === 0) {
        mergedProfileMemory = finalizeMergedMemoryContent(sessionMemoryContent);
      } else {
        failureContext.stage = "llm";
        failureContext.strategy = "llm";
        const llmMerge = await this.options.runSessionMemoryLLMMerge(
          descriptor,
          profileMemoryContent,
          sessionMemoryContent
        );
        mergedProfileMemory = finalizeMergedMemoryContent(llmMerge.mergedContent);
        llmMergeSucceeded = true;
        mergeModel = llmMerge.model;
        strategy = "llm";
        failureContext.strategy = strategy;
        failureContext.model = mergeModel;
        failureContext.llmMergeSucceeded = true;
      }

      failureContext.profileContentHashAfter = hashMemoryMergeContent(mergedProfileMemory);
      const matchesCurrentProfileMemory =
        strategy === "llm" &&
        normalizeMemoryMergeContent(mergedProfileMemory) ===
          normalizeMemoryMergeContent(profileMemoryContent);
      const shouldRepairPostApplyFailure = this.shouldRepairFailedPostApplyMerge(
        existingMeta,
        sessionContentHash,
        profileContentHashBefore
      );

      if (matchesCurrentProfileMemory && !shouldRepairPostApplyFailure) {
        strategy = "no_change";
        failureContext.strategy = strategy;
        failureContext.stage = "record_attempt";
        await this.options.recordSessionMemoryMergeAttempt(descriptor, {
          attemptId,
          timestamp: mergedAt,
          status: "skipped",
          strategy,
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });
        failureContext.stage = "write_audit";
        await this.options.appendSessionMemoryMergeAuditEntry({
          attemptId,
          timestamp: mergedAt,
          sessionAgentId: descriptor.agentId,
          profileId,
          status: "skipped",
          strategy,
          llmMergeSucceeded,
          usedFallbackAppend: false,
          appliedChange: false,
          model: mergeModel,
          sessionContentHash,
          profileContentHashBefore,
          profileContentHashAfter: profileContentHashBefore
        });

        return {
          agentId: descriptor.agentId,
          status: "skipped",
          strategy,
          mergedAt: lastAppliedAt,
          auditPath
        };
      }

      if (!matchesCurrentProfileMemory) {
        failureContext.stage = "write_profile_memory";
        await writeFile(profileMemoryPath, mergedProfileMemory, "utf8");
        failureContext.appliedChange = true;
        this.options.queueVersioningMutation({
          path: profileMemoryPath,
          action: "write",
          source: "profile-memory-merge",
          profileId,
          sessionId: descriptor.agentId,
          reviewRunId: await this.options.resolveActiveCortexReviewRunIdForDescriptor(descriptor)
        });
      }
      failureContext.stage = "refresh_session_meta_stats";
      await this.options.refreshSessionMetaStatsBySessionId(profileId);
      failureContext.stage = "record_attempt";
      await this.options.recordSessionMemoryMergeAttempt(descriptor, {
        attemptId,
        timestamp: mergedAt,
        status: "applied",
        strategy,
        sessionContentHash,
        profileContentHashBefore,
        profileContentHashAfter: failureContext.profileContentHashAfter,
        appliedSourceHash: sessionContentHash
      });

      descriptor.mergedAt = mergedAt;
      descriptor.updatedAt = mergedAt;
      this.options.upsertDescriptor(descriptor);

      failureContext.stage = "save_store";
      await this.options.saveStore();
      failureContext.stage = "write_audit";
      await this.options.appendSessionMemoryMergeAuditEntry({
        attemptId,
        timestamp: mergedAt,
        sessionAgentId: descriptor.agentId,
        profileId,
        status: "applied",
        strategy,
        llmMergeSucceeded,
        usedFallbackAppend: false,
        appliedChange: true,
        model: mergeModel,
        sessionContentHash,
        profileContentHashBefore,
        profileContentHashAfter: failureContext.profileContentHashAfter
      });

      this.options.emitAgentsSnapshot();

      return {
        agentId: descriptor.agentId,
        status: "applied",
        strategy,
        mergedAt,
        auditPath
      };
    } catch (error) {
      throw await this.finalizeSessionMemoryMergeFailure(descriptor, failureContext, error);
    } finally {
      releaseMergeLock();
    }
  }

  async executeSessionMemoryLLMMerge(
    descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string
  ): Promise<{ mergedContent: string; model: string }> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.options.config);
    const authStorage = AuthStorage.create(authFilePath);
    const modelRegistry = createPiModelRegistry(authStorage, this.options.getPiModelsJsonPath());
    const model = resolveModel(modelRegistry, descriptor.model);

    if (!model) {
      throw new Error(
        `Unable to resolve model ${descriptor.model.provider}/${descriptor.model.modelId} for memory merge.`
      );
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }

    const memoryMergePrompt = await this.options.resolvePromptWithFallback(
      "operational",
      "memory-merge",
      descriptor.profileId ?? descriptor.managerId,
      MEMORY_MERGE_SYSTEM_PROMPT
    );
    const mergedContent = await executeLLMMerge(model, profileMemoryContent, sessionMemoryContent, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      systemPrompt: memoryMergePrompt
    });

    return {
      mergedContent,
      model: `${model.provider}/${model.id}`
    };
  }

  private async acquireProfileMergeLock(profileId: string): Promise<() => void> {
    const previousLock = this.profileMergeMutexes.get(profileId) ?? Promise.resolve();
    let released = false;
    let releaseCurrentLock: (() => void) | undefined;
    const currentLock = new Promise<void>((resolve) => {
      releaseCurrentLock = resolve;
    });

    this.profileMergeMutexes.set(profileId, currentLock);
    await previousLock;

    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseCurrentLock?.();

      if (this.profileMergeMutexes.get(profileId) === currentLock) {
        this.profileMergeMutexes.delete(profileId);
      }
    };
  }

  private async recordSessionMemoryMergeFailureAttemptSafely(
    descriptor: AgentDescriptor,
    attempt: {
      attemptId?: string | null;
      timestamp: string;
      strategy?: SessionMemoryMergeStrategy | null;
      failureStage: SessionMemoryMergeFailureStage;
      sessionContentHash?: string | null;
      profileContentHashBefore?: string | null;
      profileContentHashAfter?: string | null;
      appliedSourceHash?: string | null;
      error?: string;
    }
  ): Promise<string | undefined> {
    try {
      await this.options.recordSessionMemoryMergeAttempt(descriptor, {
        ...attempt,
        status: "failed"
      });
      return undefined;
    } catch (recordError) {
      try {
        await this.options.writeSessionMemoryMergeAttemptMeta(descriptor, {
          ...attempt,
          status: "failed"
        });
        return undefined;
      } catch (fallbackError) {
        return `failed to persist merge-attempt metadata (${errorToMessage(recordError)}; fallback: ${errorToMessage(fallbackError)})`;
      }
    }
  }

  private async finalizeSessionMemoryMergeFailure(
    descriptor: AgentDescriptor,
    context: SessionMemoryMergeFailureContext,
    error: unknown
  ): Promise<SessionMemoryMergeFailure> {
    const errorMessage = errorToMessage(error);

    if (context.stage === "llm") {
      this.options.logDebug("session:memory_merge:llm_failed", {
        sessionAgentId: descriptor.agentId,
        profileId: context.profileId,
        model: descriptor.model,
        message: errorMessage
      });
    }

    const mergeErrorMessage = `Session memory merge failed during ${context.stage}: ${errorMessage}`;
    const metaFailure = await this.recordSessionMemoryMergeFailureAttemptSafely(descriptor, {
      attemptId: context.attemptId,
      timestamp: context.timestamp,
      strategy: context.strategy ?? null,
      failureStage: context.stage,
      sessionContentHash: context.sessionContentHash ?? null,
      profileContentHashBefore: context.profileContentHashBefore || null,
      profileContentHashAfter:
        (context.profileContentHashAfter ?? context.profileContentHashBefore) || null,
      appliedSourceHash: context.appliedChange ? (context.sessionContentHash ?? null) : null,
      error: mergeErrorMessage
    });

    let auditFailure: string | undefined;
    if (context.stage !== "write_audit" && context.sessionContentHash) {
      try {
        await this.options.appendSessionMemoryMergeAuditEntry({
          attemptId: context.attemptId,
          timestamp: context.timestamp,
          sessionAgentId: descriptor.agentId,
          profileId: context.profileId,
          status: "failed",
          strategy: context.strategy ?? "seed",
          stage: context.stage,
          llmMergeSucceeded: context.llmMergeSucceeded,
          usedFallbackAppend: false,
          appliedChange: context.appliedChange,
          model: context.model,
          sessionContentHash: context.sessionContentHash,
          profileContentHashBefore: context.profileContentHashBefore,
          profileContentHashAfter:
            context.profileContentHashAfter ?? context.profileContentHashBefore,
          error: mergeErrorMessage
        });
      } catch (auditError) {
        auditFailure = `failed to append merge audit entry (${errorToMessage(auditError)})`;
      }
    } else if (context.stage === "write_audit") {
      auditFailure = `failed to append merge audit entry (${errorMessage})`;
    }

    const suffixes = [metaFailure, auditFailure].filter((value): value is string => !!value);
    const finalMessage = suffixes.length > 0 ? `${mergeErrorMessage} [${suffixes.join("; ")}]` : mergeErrorMessage;

    return new SessionMemoryMergeFailure(finalMessage, {
      strategy: context.strategy,
      stage: context.stage,
      auditPath: context.auditPath
    });
  }

  private shouldSkipSessionMemoryMergeIdempotently(
    existingMeta: SessionMeta | undefined,
    sessionContentHash: string,
    profileContentHashBefore: string
  ): boolean {
    if (!existingMeta || existingMeta.lastMemoryMergeSourceHash !== sessionContentHash) {
      return false;
    }

    if (existingMeta.lastMemoryMergeStatus === "failed") {
      return false;
    }

    if (!existingMeta.lastMemoryMergeProfileHashAfter) {
      return true;
    }

    return existingMeta.lastMemoryMergeProfileHashAfter === profileContentHashBefore;
  }

  private shouldRepairFailedPostApplyMerge(
    existingMeta: SessionMeta | undefined,
    sessionContentHash: string,
    profileContentHashBefore: string
  ): boolean {
    if (!existingMeta || existingMeta.lastMemoryMergeStatus !== "failed") {
      return false;
    }

    if (existingMeta.lastMemoryMergeAppliedSourceHash !== sessionContentHash) {
      return false;
    }

    if (
      existingMeta.lastMemoryMergeFailureStage &&
      !isPostApplyFailureStage(existingMeta.lastMemoryMergeFailureStage)
    ) {
      return false;
    }

    if (!existingMeta.lastMemoryMergeProfileHashAfter) {
      return true;
    }

    return existingMeta.lastMemoryMergeProfileHashAfter === profileContentHashBefore;
  }

  private isSessionMemoryMergeNoOp(sessionMemoryContent: string): boolean {
    if (sessionMemoryContent.trim().length === 0) {
      return true;
    }

    return this.isDefaultMemoryTemplateContent(sessionMemoryContent);
  }

  private isDefaultMemoryTemplateContent(content: string): boolean {
    const normalizedLines = normalizeMemoryTemplateLines(content);

    if (normalizedLines.length !== this.defaultMemoryTemplateNormalizedLines.length) {
      return false;
    }

    for (let index = 0; index < normalizedLines.length; index += 1) {
      if (normalizedLines[index] !== this.defaultMemoryTemplateNormalizedLines[index]) {
        return false;
      }
    }

    return true;
  }
}
