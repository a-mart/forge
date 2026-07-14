import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type {
  CortexConsolidationRunRecord,
  CortexConsolidationSnapshot,
  CortexConsolidationTrigger,
  SessionMemoryMergeResult,
  SessionMeta,
} from "@forge/protocol";
import type { RuntimeTarget } from "../runtime-target.js";
import { isBuilderRuntimeTarget } from "../runtime-target.js";
import type {
  VersioningMutation,
  VersioningMutationSink,
} from "../versioning/versioning-types.js";
import { isEnoentError } from "../utils/fs-errors.js";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import type { CaptureCascadeCoordinator } from "./capture-cascade-coordinator.js";
import type {
  CompactionRuntimeSettingsProvider,
  LiveCompactionRuntimeSettingsProvider,
} from "./compaction-runtime-settings-provider.js";
import { CompactionSettingsService } from "./compaction-settings-service.js";
import {
  getCommonKnowledgePath,
  getCortexConsolidationRunsPath,
  getCortexReviewLogPath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getSessionFilePath,
  resolveMemoryFilePath,
} from "./data-paths.js";
import type {
  KnowledgeEntry,
  KnowledgeEntryScope,
  KnowledgeEntryType,
  KnowledgeSearchResult,
  KnowledgeService,
} from "./knowledge-service.js";
import type { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import { complete, getModel, type Api, type Model } from "./pi/pi-ai-compat.js";
import { createPiModelRegistry } from "./pi-model-registry.js";
import { extractMergedMemoryText } from "./prompts/memory-merge.js";
import {
  normalizeArchetypeId,
  resolvePromptVariables,
  type PromptCategory,
} from "./prompt-registry.js";
import { migrateLegacyProfileKnowledgeToReferenceDoc } from "./reference-docs.js";
import type {
  CompactAgentContextOptions,
  SwarmCompactionCoordinator,
} from "./swarm-compaction-coordinator.js";
import type { SwarmCortexService } from "./swarm-cortex-service.js";
import type {
  SessionMemoryMergeAuditEntry,
  SwarmMemoryMergeService,
} from "./swarm-memory-merge-service.js";
import type {
  SessionMemoryMergeAttemptMetaUpdate,
  SwarmSessionMetaService,
} from "./swarm-session-meta-service.js";
import type { SmartCompactResult } from "./runtime-contracts.js";
import { normalizeOptionalAgentId } from "./swarm-manager-utils.js";
import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ManagerProfile,
  MessageSourceContext,
  SwarmConfig,
} from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const CORTEX_DISPLAY_NAME = "Cortex";
const COMMON_KNOWLEDGE_INITIAL_TEMPLATE = `# Common Knowledge
<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->

## Interaction Defaults

## Workflow Defaults

## Cross-Project Technical Standards

## Cross-Project Gotchas
`;
const FORKED_SESSION_MEMORY_HEADER_TEMPLATE = [
  "# Session Memory",
  '> Forked from session "' + "$" + '{SOURCE_LABEL}" (' + "$" + "{SOURCE_AGENT_ID}) on " + "$" + "{FORK_TIMESTAMP}",
  "> " + "$" + "{FORK_HISTORY_NOTE}",
  "",
].join("\n");

type ManagerDescriptor = AgentDescriptor & { role: "manager"; profileId: string };

type CortexPort = Pick<
  SwarmCortexService,
  | "getConsolidationSnapshot"
  | "listConsolidationRuns"
  | "maybeRunConsolidationFromIncomingMessage"
  | "runConsolidation"
>;

type MemoryPort = Pick<
  SwarmMemoryMergeService,
  | "ensureAgentMemoryFile"
  | "ensureMemoryFilesForBoot"
  | "mergeSessionMemory"
  | "refreshDefaultMemoryTemplateNormalizedLines"
>;

type SessionMetaPort = Pick<
  SwarmSessionMetaService,
  | "captureSessionRuntimePromptMeta"
  | "hydrateCompactionCountsForBoot"
  | "incrementSessionCompactionCount"
  | "readSessionMetaForDescriptor"
  | "rebuildSessionManifestForBoot"
  | "refreshSessionMetaStats"
  | "refreshSessionMetaStatsBySessionId"
  | "startCompactionCountBackfill"
  | "updateSessionMetaForWorkerDescriptor"
  | "writeInitialSessionMeta"
  | "writeSessionMemoryMergeAttemptMeta"
>;

type CompactionPort = Pick<SwarmCompactionCoordinator, "compact" | "smartCompact">;

export interface KnowledgeMemoryCoordinatorOptions {
  config: Pick<
    SwarmConfig,
    "cortexEnabled" | "defaultCwd" | "defaultModel" | "paths"
  > & { runtimeTarget: RuntimeTarget };
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  services: {
    capture: Pick<
      CaptureCascadeCoordinator,
      "handleFeedbackSignal" | "noteLearningSaved"
    >;
    compaction: CompactionPort;
    cortex: CortexPort;
    knowledge: KnowledgeService;
    knowledgeSettings: KnowledgeV2SettingsService;
    memory: MemoryPort;
    sessionMeta: SessionMetaPort;
  };
  compactionSettings: {
    runtimeProvider: CompactionRuntimeSettingsProvider;
    liveProvider: LiveCompactionRuntimeSettingsProvider;
    createService?: () => CompactionSettingsService;
    getProviderAvailability: () => Promise<Map<string, boolean>>;
  };
  sessions: {
    requireBuilderSession: (agentId: string, operation: string) => ManagerDescriptor;
    assertMutable: (descriptor: AgentDescriptor) => void;
    resolvePreferredManagerId: (options?: {
      includeStoppedOnRestart?: boolean;
    }) => string | undefined;
  };
  cortexBootstrap: {
    sortedProfiles: () => ManagerProfile[];
    upsertDescriptor: (descriptor: AgentDescriptor) => void;
    upsertProfile: (profile: ManagerProfile) => void;
    ensureProfileDirectories: (profileId: string) => Promise<void>;
    ensureSessionFileParent: (sessionFile: string) => Promise<void>;
    getAgentMemoryPath: (agentId: string) => string;
    resolvePromptWithFallback: (
      category: PromptCategory,
      promptId: string,
      profileId: string | undefined,
      fallback: string,
    ) => Promise<string>;
  };
  getPiModelsJsonPath: () => string;
  versioning?: VersioningMutationSink;
  now: () => string;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}

export interface SaveLearningInput {
  type: KnowledgeEntryType;
  scope: KnowledgeEntryScope;
  title: string;
  body: string;
  evidence: "user-stated" | "observed";
}

/**
 * Application owner for the knowledge/memory surface exposed through SwarmManager.
 *
 * The focused services retain their algorithms and mutable state. This coordinator owns only
 * cross-service policy: caller authorization, boot ordering, Cortex profile materialization,
 * compaction-settings attachment, and the compact facade methods used by routes/runtime hosts.
 */
export class KnowledgeMemoryCoordinator {
  private compactionSettingsService: CompactionSettingsService | null = null;

  constructor(private readonly options: KnowledgeMemoryCoordinatorOptions) {}

  getCompactionRuntimeSettingsProvider(): CompactionRuntimeSettingsProvider {
    return this.options.compactionSettings.runtimeProvider;
  }

  getCompactionSettingsService(): CompactionSettingsService | null {
    return this.compactionSettingsService;
  }

  getKnowledgeV2SettingsService(): KnowledgeV2SettingsService {
    return this.options.services.knowledgeSettings;
  }

  getKnowledgeService(): KnowledgeService {
    return this.options.services.knowledge;
  }

  async loadCompactionSettingsForRuntime(): Promise<void> {
    if (!isBuilderRuntimeTarget(this.options.config.runtimeTarget) || this.compactionSettingsService) {
      return;
    }

    const service = this.options.compactionSettings.createService?.() ?? new CompactionSettingsService({
      dataDir: this.options.config.paths.dataDir,
      getProviderAvailability: this.options.compactionSettings.getProviderAvailability,
    });
    await service.load();
    this.compactionSettingsService = service;

    if (this.options.compactionSettings.runtimeProvider === this.options.compactionSettings.liveProvider) {
      this.options.compactionSettings.liveProvider.attachSettingsService(service);
    }
  }

  async compact(agentId: string, options?: CompactAgentContextOptions): Promise<unknown> {
    return this.options.services.compaction.compact(agentId, options);
  }

  async smartCompact(
    agentId: string,
    options?: CompactAgentContextOptions,
  ): Promise<SmartCompactResult> {
    return this.options.services.compaction.smartCompact(agentId, options);
  }

  async listCortexConsolidationRuns(): Promise<CortexConsolidationRunRecord[]> {
    return this.options.services.cortex.listConsolidationRuns();
  }

  async getCortexConsolidationSnapshot(): Promise<CortexConsolidationSnapshot> {
    return this.options.services.cortex.getConsolidationSnapshot();
  }

  async runCortexConsolidation(
    trigger: CortexConsolidationTrigger,
  ): Promise<CortexConsolidationRunRecord | null> {
    return this.options.services.cortex.runConsolidation(trigger);
  }

  async maybeRunCortexConsolidationFromIncomingMessage(
    text: string,
    target: AgentDescriptor,
    sourceContext: MessageSourceContext,
  ): Promise<boolean> {
    return this.options.services.cortex.maybeRunConsolidationFromIncomingMessage(
      text,
      target,
      sourceContext,
    );
  }

  async searchKnowledge(
    callerAgentId: string,
    input: { query?: string; scope?: "global" | "profile" | "all"; limit?: number },
  ): Promise<KnowledgeSearchResult[]> {
    this.assertKnowledgeV2Enabled();
    const profileId = this.resolveKnowledgeCallerProfileId(callerAgentId);
    return this.options.services.knowledge.searchEntries({
      query: input.query,
      scope: input.scope ?? "all",
      profileId,
      limit: input.limit,
    });
  }

  async readKnowledgeEntry(callerAgentId: string, id: string): Promise<KnowledgeEntry> {
    this.assertKnowledgeV2Enabled();
    this.resolveKnowledgeCallerProfileId(callerAgentId);
    return this.options.services.knowledge.readEntry(id);
  }

  async saveLearning(callerAgentId: string, input: SaveLearningInput): Promise<KnowledgeEntry> {
    this.assertKnowledgeV2Enabled();
    const caller = this.options.descriptors.get(callerAgentId);
    if (!caller || caller.role !== "manager") {
      throw new Error("save_learning is manager-only.");
    }

    const profileId = this.resolveKnowledgeCallerProfileId(callerAgentId);
    if (!profileId && input.scope !== "global") {
      throw new Error("Profile-scoped knowledge requires a caller profile.");
    }

    const entry = await this.options.services.knowledge.saveLearning({
      ...input,
      scope: input.scope === "global" ? "global" : input.scope || `profile:${profileId}`,
      sessionId: caller.agentId,
    });
    await this.options.services.capture.noteLearningSaved(caller.agentId);
    return entry;
  }

  async handleCaptureFeedbackSignal(profileId: string, sessionId: string): Promise<void> {
    await this.options.services.capture.handleFeedbackSignal(profileId, sessionId);
  }

  async mergeSessionMemory(agentId: string): Promise<SessionMemoryMergeResult> {
    const descriptor = this.options.sessions.requireBuilderSession(
      agentId,
      "merge Builder session memory",
    );
    this.options.sessions.assertMutable(descriptor);
    return this.options.services.memory.mergeSessionMemory(agentId);
  }

  getAgentMemoryPath(agentId: string): string {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) {
      const fallbackAgentId = normalizeOptionalAgentId(agentId) ?? agentId;
      return resolveMemoryFilePath(this.options.config.paths.dataDir, {
        agentId: fallbackAgentId,
        role: "manager",
        profileId: fallbackAgentId,
        managerId: fallbackAgentId,
      });
    }

    const parentDescriptor = descriptor.role === "worker"
      ? this.options.descriptors.get(descriptor.managerId)
      : undefined;
    const parentProfileId = descriptor.role === "worker"
      ? normalizeOptionalAgentId(parentDescriptor?.profileId ?? descriptor.profileId)
      : undefined;
    return resolveMemoryFilePath(
      this.options.config.paths.dataDir,
      {
        agentId: descriptor.agentId,
        role: descriptor.role,
        profileId: descriptor.profileId,
        managerId: descriptor.managerId,
      },
      parentProfileId ? { profileId: parentProfileId } : undefined,
    );
  }

  resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }
    return normalizeOptionalAgentId(descriptor.managerId)
      ?? this.options.sessions.resolvePreferredManagerId({ includeStoppedOnRestart: true })
      ?? descriptor.agentId;
  }

  resolveSessionProfileId(memoryOwnerAgentId: string): string | undefined {
    const descriptor = this.options.descriptors.get(memoryOwnerAgentId);
    if (!descriptor || descriptor.role !== "manager") {
      return undefined;
    }
    return normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
  }

  async writeForkedSessionMemoryHeader(
    sourceDescriptor: AgentDescriptor,
    forkedSessionAgentId: string,
    fromMessageId?: string,
  ): Promise<void> {
    const sourceLabel = sourceDescriptor.sessionLabel ?? sourceDescriptor.agentId;
    const profileId = sourceDescriptor.profileId ?? sourceDescriptor.agentId;
    const forkHistoryNote = fromMessageId
      ? `Parent session conversation history was copied through message ${fromMessageId} at fork time.`
      : "Parent session conversation history was duplicated at fork time.";
    const headerTemplate = await this.options.cortexBootstrap.resolvePromptWithFallback(
      "operational",
      "forked-session-header",
      profileId,
      FORKED_SESSION_MEMORY_HEADER_TEMPLATE,
    );
    let header = resolvePromptVariables(headerTemplate, {
      SOURCE_LABEL: sourceLabel,
      SOURCE_AGENT_ID: sourceDescriptor.agentId,
      FORK_TIMESTAMP: this.options.now(),
      FORK_HISTORY_NOTE: forkHistoryNote,
      FROM_MESSAGE_ID: fromMessageId ?? "",
    });
    if (fromMessageId && !header.includes(fromMessageId)) {
      header = `${header.trimEnd()}\n> ${forkHistoryNote}\n`;
    }

    const forkedMemoryPath = this.getAgentMemoryPath(forkedSessionAgentId);
    await mkdir(dirname(forkedMemoryPath), { recursive: true });
    await writeFile(forkedMemoryPath, header, "utf8");
    await this.options.services.sessionMeta.refreshSessionMetaStatsBySessionId(forkedSessionAgentId);
  }

  async executeCaptureJudgePrompt(prompt: string): Promise<string> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.options.config);
    const authStorage = AuthStorage.create(authFilePath);
    const modelRegistry = createPiModelRegistry(authStorage, this.options.getPiModelsJsonPath());
    const candidates = [
      { provider: "openai-codex", modelId: "gpt-5.4-mini" },
      { provider: "openai-codex", modelId: "gpt-5.4" },
    ] as const;

    for (const candidate of candidates) {
      const model = modelRegistry.find(candidate.provider, candidate.modelId)
        ?? (getModel(candidate.provider as never, candidate.modelId as never) as Model<Api> | undefined);
      if (!model) continue;
      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) continue;
      const response = await complete(
        model,
        {
          systemPrompt: "You are a cheap binary classifier. Return only the requested YES/NO line.",
          messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: prompt }] }],
        },
        auth.apiKey || auth.headers
          ? {
              ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
              ...(auth.headers ? { headers: auth.headers } : {}),
            }
          : undefined,
      );
      return extractMergedMemoryText(response);
    }

    throw new Error("No configured cheap model is available for Cortex capture judge.");
  }

  async refreshMemoryTemplateForBoot(): Promise<void> {
    await this.options.services.memory.refreshDefaultMemoryTemplateNormalizedLines();
  }

  async ensureMemoryFilesForBoot(): Promise<void> {
    await this.options.services.memory.ensureMemoryFilesForBoot();
  }

  async ensureCortexProfileForBoot(): Promise<void> {
    if (!this.options.config.cortexEnabled) {
      await this.ensureCommonKnowledgeFile();
      return;
    }

    if (this.hasCortexRootDescriptor()) {
      const existingProfile = this.options.profiles.get(CORTEX_PROFILE_ID);
      if (existingProfile && existingProfile.profileType !== "system") {
        this.options.cortexBootstrap.upsertProfile({
          ...existingProfile,
          profileType: "system",
        });
      }
      await this.ensureCommonKnowledgeFile();
      await this.ensureCortexOperationalFiles();
      return;
    }

    if (this.options.descriptors.has(CORTEX_PROFILE_ID)) {
      throw new Error(
        `Cannot auto-create Cortex profile because agentId "${CORTEX_PROFILE_ID}" is already in use`,
      );
    }

    const createdAt = this.options.now();
    const existingProfile = this.options.profiles.get(CORTEX_PROFILE_ID);
    const defaultModel: AgentModelDescriptor = existingProfile?.defaultModel
      ? { ...existingProfile.defaultModel }
      : { ...this.options.config.defaultModel };
    const descriptor: ManagerDescriptor = {
      agentId: CORTEX_PROFILE_ID,
      displayName: CORTEX_DISPLAY_NAME,
      role: "manager",
      managerId: CORTEX_PROFILE_ID,
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: this.options.config.defaultCwd,
      model: { ...defaultModel },
      modelOrigin: "profile_default",
      sessionFile: getSessionFilePath(
        this.options.config.paths.dataDir,
        CORTEX_PROFILE_ID,
        CORTEX_PROFILE_ID,
      ),
    };
    const profile: ManagerProfile = existingProfile
      ? {
          ...existingProfile,
          defaultSessionAgentId: CORTEX_PROFILE_ID,
          defaultModel: { ...existingProfile.defaultModel },
          profileType: "system",
        }
      : {
          profileId: CORTEX_PROFILE_ID,
          displayName: CORTEX_DISPLAY_NAME,
          defaultSessionAgentId: CORTEX_PROFILE_ID,
          defaultModel: { ...defaultModel },
          createdAt,
          updatedAt: createdAt,
          profileType: "system",
        };

    this.options.cortexBootstrap.upsertDescriptor(descriptor);
    this.options.cortexBootstrap.upsertProfile(profile);
    await this.options.cortexBootstrap.ensureProfileDirectories(profile.profileId);
    await this.options.cortexBootstrap.ensureSessionFileParent(descriptor.sessionFile);
    await this.options.services.memory.ensureAgentMemoryFile(
      this.options.cortexBootstrap.getAgentMemoryPath(descriptor.agentId),
      profile.profileId,
    );
    await this.options.services.memory.ensureAgentMemoryFile(
      getProfileMemoryPath(this.options.config.paths.dataDir, profile.profileId),
      profile.profileId,
    );
    await this.options.services.sessionMeta.writeInitialSessionMeta(descriptor);
    await this.options.services.sessionMeta.refreshSessionMetaStats(descriptor);
    await this.ensureCommonKnowledgeFile();
    await this.ensureCortexOperationalFiles();

    this.options.logDebug("cortex:profile:auto_created", {
      profileId: CORTEX_PROFILE_ID,
      archetypeId: CORTEX_ARCHETYPE_ID,
    });
  }

  async migrateLegacyProfileKnowledge(profileId: string): Promise<void> {
    await migrateLegacyProfileKnowledgeToReferenceDoc(
      this.options.config.paths.dataDir,
      profileId,
      { versioning: this.options.versioning },
    );
  }

  async migrateLegacyProfileKnowledgeForBoot(): Promise<void> {
    await Promise.all(
      this.options.cortexBootstrap
        .sortedProfiles()
        .map((profile) => this.migrateLegacyProfileKnowledge(profile.profileId)),
    );
  }

  async ensureAgentMemoryFile(memoryFilePath: string, profileId?: string): Promise<void> {
    await this.options.services.memory.ensureAgentMemoryFile(memoryFilePath, profileId);
  }

  async appendSessionMemoryMergeAuditEntry(entry: SessionMemoryMergeAuditEntry): Promise<void> {
    await appendFile(
      getProfileMergeAuditLogPath(this.options.config.paths.dataDir, entry.profileId),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  }

  async rebuildSessionManifestForBoot(): Promise<void> {
    await this.options.services.sessionMeta.rebuildSessionManifestForBoot();
  }

  async hydrateCompactionCountsForBoot(): Promise<void> {
    await this.options.services.sessionMeta.hydrateCompactionCountsForBoot();
  }

  startCompactionCountBackfill(): void {
    this.options.services.sessionMeta.startCompactionCountBackfill();
  }

  async writeInitialSessionMeta(descriptor: AgentDescriptor): Promise<void> {
    await this.options.services.sessionMeta.writeInitialSessionMeta(descriptor);
  }

  async captureSessionRuntimePromptMeta(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null,
  ): Promise<void> {
    await this.options.services.sessionMeta.captureSessionRuntimePromptMeta(
      descriptor,
      resolvedSystemPrompt,
    );
  }

  async updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null,
  ): Promise<void> {
    await this.options.services.sessionMeta.updateSessionMetaForWorkerDescriptor(
      descriptor,
      resolvedSystemPrompt,
    );
  }

  async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string,
  ): Promise<void> {
    await this.options.services.sessionMeta.refreshSessionMetaStats(
      descriptor,
      sessionFileOverride,
    );
  }

  async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string,
  ): Promise<void> {
    await this.options.services.sessionMeta.refreshSessionMetaStatsBySessionId(
      sessionAgentId,
      sessionFileOverride,
    );
  }

  async incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string,
  ): Promise<number | undefined> {
    return this.options.services.sessionMeta.incrementSessionCompactionCount(
      profileId,
      sessionId,
      failureLogKey,
    );
  }

  async readSessionMetaForDescriptor(descriptor: AgentDescriptor): Promise<SessionMeta | undefined> {
    return this.options.services.sessionMeta.readSessionMetaForDescriptor(descriptor);
  }

  async writeSessionMemoryMergeAttemptMeta(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate,
  ): Promise<void> {
    await this.options.services.sessionMeta.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  async recordSessionMemoryMergeAttempt(
    descriptor: AgentDescriptor,
    attempt: SessionMemoryMergeAttemptMetaUpdate,
  ): Promise<void> {
    await this.options.services.sessionMeta.writeSessionMemoryMergeAttemptMeta(descriptor, attempt);
  }

  private assertKnowledgeV2Enabled(): void {
    if (!this.options.services.knowledgeSettings.getSettings().enabled) {
      throw new Error("Knowledge v2 is disabled in Settings.");
    }
  }

  private resolveKnowledgeCallerProfileId(callerAgentId: string): string | undefined {
    const caller = this.options.descriptors.get(callerAgentId);
    if (!caller) {
      throw new Error(`Unknown agent: ${callerAgentId}`);
    }
    if (caller.profileId) {
      return caller.profileId;
    }
    return this.options.descriptors.get(caller.managerId)?.profileId;
  }

  private hasCortexRootDescriptor(): boolean {
    const descriptor = this.options.descriptors.get(CORTEX_PROFILE_ID);
    return Boolean(
      descriptor
      && descriptor.role === "manager"
      && descriptor.profileId === CORTEX_PROFILE_ID
      && normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID
      && descriptor.sessionPurpose !== "cortex_review"
      && descriptor.sessionPurpose !== "agent_creator",
    );
  }

  private async ensureCommonKnowledgeFile(): Promise<void> {
    const commonKnowledgePath = getCommonKnowledgePath(this.options.config.paths.dataDir);
    try {
      await readFile(commonKnowledgePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) throw error;
    }

    const template = await this.options.cortexBootstrap.resolvePromptWithFallback(
      "operational",
      "common-knowledge-template",
      CORTEX_PROFILE_ID,
      COMMON_KNOWLEDGE_INITIAL_TEMPLATE,
    );
    await mkdir(dirname(commonKnowledgePath), { recursive: true });
    await writeFile(commonKnowledgePath, template, "utf8");
    this.queueVersioningMutation({
      path: commonKnowledgePath,
      action: "write",
      source: "bootstrap",
      profileId: CORTEX_PROFILE_ID,
    });
  }

  private async ensureCortexOperationalFiles(): Promise<void> {
    const knowledgeDir = dirname(getCortexReviewLogPath(this.options.config.paths.dataDir));
    const reviewLogPath = getCortexReviewLogPath(this.options.config.paths.dataDir);
    const consolidationRunsPath = getCortexConsolidationRunsPath(this.options.config.paths.dataDir);
    await mkdir(knowledgeDir, { recursive: true });
    await this.writeFileIfMissing(reviewLogPath, "");
    await this.writeFileIfMissing(
      consolidationRunsPath,
      `${JSON.stringify({ version: 1, runs: [] }, null, 2)}\n`,
    );
  }

  private async writeFileIfMissing(path: string, content: string): Promise<void> {
    try {
      await readFile(path, "utf8");
    } catch (error) {
      if (!isEnoentError(error)) throw error;
      await writeFile(path, content, "utf8");
    }
  }

  private queueVersioningMutation(mutation: VersioningMutation): void {
    void this.options.versioning?.recordMutation(mutation).catch((error) => {
      this.options.logDebug("versioning:record_error", {
        path: mutation.path,
        source: mutation.source,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
