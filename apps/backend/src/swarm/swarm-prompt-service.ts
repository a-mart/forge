import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRepoProjectAgentSource, type PromptPreviewResponse, type PromptPreviewSection, type SpecialistTargetSpace } from "@forge/protocol";
import { assembleClaudePrompt, discoverAgentsMd } from "./claude-prompt-assembler.js";
import {
  getCommonKnowledgePath,
  getProfileMemoryPath,
  getProjectAgentPromptPath,
  getSessionContextPromptPath,
  getSessionContextReferenceDir,
  getSessionReferenceDir,
} from "./data-paths.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { getOnboardingSnapshot } from "./onboarding-state.js";
import {
  normalizeArchetypeId,
  resolvePromptVariables,
  type PromptRegistry,
} from "./prompt-registry.js";
import {
  generateProjectAgentDirectoryBlock,
  getProjectAgentPublicName,
  listProjectAgents,
  type ProjectAgentDirectoryEntry,
} from "./project-agents.js";
import {
  assertRepoProjectAgentSourceAvailable,
  resolveRepoProjectAgentSource
} from "./agents/repo-project-agent-source.js";
import { readProjectAgentRecord, type ProjectAgentOnDiskRecord } from "./project-agent-storage.js";
import { listRepositoryReferenceDocs } from "./project-reference-docs.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import { ProjectWorkspaceResolver } from "./project-workspace-resolver.js";
import {
  listProjectAgentReferenceDocs,
  readProjectAgentReferenceDoc,
} from "./reference-docs.js";
import {
  listReferenceDocs,
  readPromptFile,
  readReferenceDoc,
} from "./storage/asset-root-storage.js";
import type { SkillMetadata, SkillMetadataService } from "./skill-metadata-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "./types.js";
import {
  buildSessionMemoryRuntimeView,
  escapeXmlForPreview,
  isCollabSession,
  isEnoentError,
  normalizeOptionalAgentId,
} from "./swarm-manager-utils.js";

const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users see only manager-owned user-visible outputs: final web replies, \`speak_to_user\` deliveries, and structured choice UI.
- Your plain assistant text is not directly visible to end users.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at \${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.`;
const CURSOR_SDK_RUNTIME_GUIDANCE_BLOCK = `## Cursor SDK Runtime

You are running as a Cursor SDK worker. Your coding tools (file read/write/edit, search, terminal) are provided natively by Cursor.

Forge coordination tools are available through MCP:
- \`send_message_to_agent\` — report back to your manager when done or blocked
- \`list_agents\` — check other agents if needed

Always report back to your manager with send_message_to_agent when your task is complete or if you hit a blocker.`;
const MANAGER_ARCHETYPE_ID = "manager";
const CORTEX_ARCHETYPE_ID = "cortex";
const COMMON_KNOWLEDGE_MEMORY_HEADER =
  "# Common Knowledge (maintained by Cortex — read-only reference)";
const ONBOARDING_SNAPSHOT_MEMORY_HEADER =
  "# Onboarding Snapshot (authoritative backend state — read-only reference)";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const AGENTS_CONTEXT_FILE_NAME = "AGENTS.md";
const COLLABORATION_CHANNEL_INSTRUCTIONS = `This session backs a trusted Forge collaboration channel with multiple human participants.
- Treat every reply as visible to the full channel audience.
- Keep answers concise, easy to scan, and explicit about decisions, blockers, and next steps when relevant.
- Normal manager capabilities remain available here, including specialists, workers, current activity visibility, and current tool behavior.
- Delegate when it helps, then summarize the outcome back into the channel in a way humans can follow.`;
const PROJECT_AGENT_BASE_PROMPT_ID = "project-agent-base";
const PROJECT_AGENT_BASE_FALLBACK = `# Forge Project Agent Operating Contract

You are a Forge Project Agent: a promoted peer manager session. Final/standalone direct web end-user replies may use normal assistant final text. Kickoff/progress before continuing work, non-web, explicit-target, proactive, or internal-to-user delivery uses speak_to_user. Peer manager or Project Agent context messages must be coordinated with send_message_to_agent unless explicitly reporting to the end user.

Treat WORKER REPORT: status: done|partial|blocked messages as terminal worker reports that require same-turn handling via speak_to_user for user-facing closeouts, send_message_to_agent for peer/context replies, or further delegation when needed.

\${MODEL_SPECIFIC_INSTRUCTIONS}

\${SPECIALIST_ROSTER}`;
const PROJECT_AGENT_ROUTING_FOOTER = `# Non-Negotiable Forge Routing Contract
- Final/standalone direct web end-user replies in this Project Agent session: answer with normal assistant final text unless a structured choice or explicit routed delivery is needed.
- Kickoff/progress before continuing work, non-web, proactive, or explicit-target user delivery: use \`speak_to_user\` with the appropriate target metadata.
- Peer manager / Project Agent context messages: coordinate or reply with \`send_message_to_agent\` to the sender; do not use \`speak_to_user\` unless explicitly reporting to the end user.
- Worker reports still require explicit same-turn handling: use \`speak_to_user\` for user-facing closeouts, \`send_message_to_agent\` for peer/context replies, or delegate follow-up work.
- Do not both call \`speak_to_user\` and emit a normal assistant final answer with the same reply.`;

export type ProjectAgentPromptSource =
  | { kind: "project_agent_base"; sourcePath?: string; fallback?: boolean }
  | { kind: "session_system_prompt"; agentId: string }
  | { kind: "repo_prompt"; sourcePath: string; definitionId: string }
  | { kind: "profile_prompt"; sourcePath: string; handle: string }
  | { kind: "descriptor_fallback"; handle: string }
  | { kind: "base_only" };

export interface ProjectAgentPromptComposition {
  content: string;
  rolePrompt?: string;
  sources: ProjectAgentPromptSource[];
}

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  promptBody?: string;
}

interface SpecialistRegistryModuleLike {
  resolveRoster(profileId: string, targetSpace?: SpecialistTargetSpace): Promise<ResolvedSpecialistDefinitionLike[]>;
  generateRosterBlock(roster: ResolvedSpecialistDefinitionLike[]): string;
  getSpecialistsEnabled(): Promise<boolean>;
  legacyModelRoutingGuidance: string;
}

interface MemoryRuntimeResources {
  memoryContextFile: { path: string; content: string };
  additionalSkillPaths: string[];
  skillMetadata: SkillMetadata[];
}

export interface SwarmPromptServiceOptions {
  config: SwarmConfig;
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  promptRegistry: PromptRegistry;
  skillMetadataService: SkillMetadataService;
  getAgentMemoryPath: (agentId: string) => string;
  ensureAgentMemoryFile: (memoryFilePath: string, profileId: string) => Promise<void>;
  resolveMemoryOwnerAgentId: (descriptor: AgentDescriptor) => string;
  resolveSessionProfileId: (memoryOwnerAgentId: string) => string | undefined;
  refreshSessionMetaStats: (descriptor: AgentDescriptor) => Promise<void>;
  refreshSessionMetaStatsBySessionId: (sessionAgentId: string) => Promise<void>;
  getSessionsForProfile: (profileId: string) => AgentDescriptor[];
  getExternalProjectAgentDirectoryEntries?: (profileId: string) => Promise<ProjectAgentDirectoryEntry[]> | ProjectAgentDirectoryEntry[];
  loadSpecialistRegistryModule: () => Promise<SpecialistRegistryModuleLike>;
  resolveSpecialistRosterForManager?: (
    manager: AgentDescriptor,
    targetSpace?: SpecialistTargetSpace,
  ) => Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSkillRosterForDescriptor?: (descriptor: AgentDescriptor) => Promise<SkillMetadata[] | null | undefined>;
  getWorkPlansEnabled?: () => boolean;
  getIntegrationContext: (profileId: string) => string | undefined;
  logDebug: (message: string, details?: unknown) => void;
}

export class SwarmPromptService {
  constructor(private readonly options: SwarmPromptServiceOptions) {}

  async previewManagerSystemPrompt(profileId: string): Promise<PromptPreviewResponse> {
    const profile = this.options.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const defaultDescriptor = this.options.descriptors.get(profile.defaultSessionAgentId);
    const descriptor =
      (isSessionAgent(defaultDescriptor) ? defaultDescriptor : undefined) ??
      this.options.getSessionsForProfile(profileId).find(isSessionAgent);

    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Profile default session is missing: ${profile.defaultSessionAgentId}`);
    }

    return this.previewManagerSystemPromptForAgent(descriptor.agentId);
  }

  async previewManagerSystemPromptForAgent(agentId: string): Promise<PromptPreviewResponse> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!isSessionAgent(descriptor)) {
      throw new Error(`Unknown manager session: ${agentId}`);
    }

    const resolvedProfileId = normalizeOptionalAgentId(descriptor.profileId) ?? descriptor.agentId;
    const projectAgentComposition = descriptor.projectAgent?.handle
      ? await this.resolveProjectAgentPromptComposition(descriptor)
      : undefined;
    const archetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;
    const archetypeEntry = projectAgentComposition
      ? undefined
      : await this.options.promptRegistry.resolveEntry("archetype", archetypeId, resolvedProfileId);
    if (!projectAgentComposition && !archetypeEntry) {
      throw new Error(`Prompt not found: archetype/${archetypeId}`);
    }

    const [resolvedSystemPrompt, memoryResources, swarmContextFiles] = await Promise.all([
      this.resolveSystemPromptForDescriptor(descriptor),
      this.getMemoryRuntimeResources(descriptor),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);
    const systemPrompt = await this.appendAvailableSkillsBlock(resolvedSystemPrompt, descriptor);

    const systemPromptSource = projectAgentComposition
      ? this.formatProjectAgentPromptSources(projectAgentComposition.sources)
      : archetypeEntry!.sourcePath;

    const sections: PromptPreviewSection[] = [
      {
        label: "System Prompt",
        source: systemPromptSource,
        content: systemPrompt,
      },
      {
        label: "Memory Composite",
        source: memoryResources.memoryContextFile.path,
        content: memoryResources.memoryContextFile.content,
      },
    ];

    const activeWorkContext = await this.getActiveWorkPromptPreviewSection(descriptor);
    if (activeWorkContext) {
      sections.push(activeWorkContext);
    }

    const agentsPath = join(descriptor.cwd, AGENTS_CONTEXT_FILE_NAME);
    if (existsSync(agentsPath)) {
      try {
        sections.push({
          label: AGENTS_CONTEXT_FILE_NAME,
          source: agentsPath,
          content: await readFile(agentsPath, "utf8"),
        });
      } catch (error) {
        this.options.logDebug("prompt:preview:agents_read:error", {
          profileId: resolvedProfileId,
          path: agentsPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const contextFile of swarmContextFiles) {
      sections.push({
        label: SWARM_CONTEXT_FILE_NAME,
        source: contextFile.path,
        content: contextFile.content,
      });
    }

    return { sections };
  }

  async buildResolvedManagerPrompt(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const managerArchetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;

    const specialistRegistry = await this.options.loadSpecialistRegistryModule();
    const projectAgentComposition = descriptor.projectAgent?.handle
      ? await this.resolveProjectAgentPromptComposition(descriptor, options)
      : undefined;
    const normalizedSessionSystemPrompt = normalizeOptionalAgentId(descriptor.sessionSystemPrompt)?.trim();
    const [promptTemplate, roster, specialistsEnabled] = await Promise.all([
      projectAgentComposition
        ? Promise.resolve(projectAgentComposition.content)
        : normalizedSessionSystemPrompt
          ? Promise.resolve(normalizedSessionSystemPrompt)
          : this.options.promptRegistry.resolve("archetype", managerArchetypeId, profileId),
      this.resolveSpecialistRosterForDescriptor(descriptor, specialistRegistry),
      specialistRegistry.getSpecialistsEnabled(),
    ]);

    const delegationBlock = specialistsEnabled
      ? specialistRegistry.generateRosterBlock(roster)
      : specialistRegistry.legacyModelRoutingGuidance;
    const projectAgentDirectoryBlock = generateProjectAgentDirectoryBlock(
      await this.resolveProjectAgentDirectoryEntries(profileId, descriptor),
    );
    const createSessionCapabilityNote =
      descriptor.projectAgent?.capabilities?.includes("create_session")
        ? "\n- This project agent can create new manager sessions via create_session."
        : "";
    const delegationContextBlock = `${delegationBlock}\n\n${projectAgentDirectoryBlock}${createSessionCapabilityNote}`;
    let prompt = resolvePromptVariables(promptTemplate, this.buildStandardPromptVariables(descriptor));

    const projectAgentReferenceDocs = await this.resolveProjectAgentReferenceDocs(descriptor, profileId);
    if (projectAgentReferenceDocs.length > 0) {
      prompt = `${prompt.trimEnd()}\n\n<agent_reference_docs>\n${projectAgentReferenceDocs.map((doc) => `## ${doc.path}\n${doc.content}`).join("\n\n")}\n</agent_reference_docs>`;
    }

    // eslint-disable-next-line no-template-curly-in-string
    if (prompt.includes("${SPECIALIST_ROSTER}")) {
      // eslint-disable-next-line no-template-curly-in-string
      prompt = prompt.replaceAll("${SPECIALIST_ROSTER}", delegationContextBlock);
    } else {
      prompt = `${prompt.trimEnd()}\n\n${delegationContextBlock}`;
    }

    const modelSpecificInstructionsPlaceholders = [
      "${MODEL_SPECIFIC_INSTRUCTIONS}", // eslint-disable-line no-template-curly-in-string
      "${Model_Specific_Instructions}", // eslint-disable-line no-template-curly-in-string
      "${model_specific_instructions}", // eslint-disable-line no-template-curly-in-string
    ];
    if (modelSpecificInstructionsPlaceholders.some((placeholder) => prompt.includes(placeholder))) {
      const effectiveModelSpecificInstructions = modelCatalogService.getEffectiveModelSpecificInstructions(
        descriptor.model.modelId,
        descriptor.model.provider,
      );
      const modelSpecificInstructionsBlock = effectiveModelSpecificInstructions
        ? `# Model-Specific Instructions\n${effectiveModelSpecificInstructions}`
        : "";
      for (const placeholder of modelSpecificInstructionsPlaceholders) {
        prompt = prompt.replaceAll(placeholder, modelSpecificInstructionsBlock);
      }
    }

    try {
      const integrationContext = this.options.getIntegrationContext(profileId)?.trim();
      if (integrationContext) {
        prompt = `${prompt}\n\n${integrationContext}`;
      }
    } catch (error) {
      this.options.logDebug("manager:integration_context:error", {
        agentId: descriptor.agentId,
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (isCollabSession(descriptor)) {
      prompt = await this.appendCollabContextOverlays(descriptor, prompt);
    } else {
      prompt = await this.appendRepositoryReferenceInventory(prompt, descriptor);
    }

    if (projectAgentComposition) {
      prompt = `${prompt.trimEnd()}\n\n${PROJECT_AGENT_ROUTING_FOOTER}`;
    }

    return prompt;
  }

  private async resolveProjectAgentDirectoryEntries(
    profileId: string,
    requester: AgentDescriptor,
  ): Promise<ProjectAgentDirectoryEntry[]> {
    const entries: ProjectAgentDirectoryEntry[] = [];
    for (const entry of listProjectAgents(this.options.descriptors.values(), profileId, {
      excludeAgentId: requester.agentId,
    })) {
      if (isRepoProjectAgentSource(entry.projectAgent.source)) {
        try {
          const resolution = await resolveRepoProjectAgentSource({
            descriptor: entry,
            profileId,
            handle: entry.projectAgent.handle,
          }, { dataDir: this.options.config.paths.dataDir });
          const definition = assertRepoProjectAgentSourceAvailable(resolution);
          await this.assertRequesterWorkspaceMatchesRepoSource(requester, entry.projectAgent.source);
          entries.push({
            agentId: entry.agentId,
            displayName: getProjectAgentPublicName(entry),
            handle: definition.config.handle,
            whenToUse: definition.config.whenToUse,
            ...(entry.projectAgent.capabilities !== undefined ? { capabilities: entry.projectAgent.capabilities } : {}),
          });
        } catch (error) {
          this.options.logDebug("project_agent:directory:exclude_unavailable_repo_source", {
            requesterAgentId: requester.agentId,
            agentId: entry.agentId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      entries.push({
        agentId: entry.agentId,
        displayName: getProjectAgentPublicName(entry),
        handle: entry.projectAgent.handle,
        whenToUse: entry.projectAgent.whenToUse,
        ...(entry.projectAgent.capabilities !== undefined ? { capabilities: entry.projectAgent.capabilities } : {}),
      });
    }

    const externalEntries = await Promise.resolve(
      this.options.getExternalProjectAgentDirectoryEntries?.(profileId) ?? [],
    );
    for (const entry of externalEntries) {
      entries.push({
        agentId: entry.agentId,
        displayName: entry.displayName,
        handle: entry.handle,
        whenToUse: entry.whenToUse,
        origin: "external",
        sourceProjectName: entry.sourceProjectName,
      });
    }

    return entries;
  }

  private async assertRequesterWorkspaceMatchesRepoSource(
    requester: AgentDescriptor,
    source: NonNullable<AgentDescriptor["projectAgent"]>["source"],
  ): Promise<void> {
    if (!isRepoProjectAgentSource(source)) {
      return;
    }
    const resolution = await new ProjectWorkspaceResolver({
      dataDir: this.options.config.paths.dataDir,
      settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
    }).resolvePassive({
      profileId: requester.profileId ?? requester.agentId,
      sessionAgentId: requester.agentId,
      cwd: requester.cwd,
    });
    if (
      resolution.workspaceKey !== source.workspaceKey ||
      resolution.effectiveForgeDirRealpath !== source.forgeDirRealpath
    ) {
      throw new Error(
        `Requester workspace ${resolution.workspaceKey} does not match repository project-agent workspace ${source.workspaceKey}`,
      );
    }
  }

  async resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;

    if (descriptor.role === "manager") {
      return this.buildResolvedManagerPrompt(descriptor);
    }

    const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
    if (specialistId) {
      try {
        const specialistRegistry = await this.options.loadSpecialistRegistryModule();
        const roster = await this.resolveSpecialistRosterForDescriptor(descriptor, specialistRegistry);
        const specialist = roster.find((entry) => entry.specialistId === specialistId);
        const specialistPrompt = specialist?.promptBody?.trim();
        if (specialistPrompt) {
          return this.appendRepositoryReferenceInventory(specialistPrompt, descriptor);
        }
      } catch (error) {
        this.options.logDebug("specialist:resolve:error", {
          agentId: descriptor.agentId,
          profileId,
          specialistId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (descriptor.archetypeId) {
      const normalizedArchetypeId = normalizeArchetypeId(descriptor.archetypeId);
      if (normalizedArchetypeId) {
        const archetypePrompt = await this.options.promptRegistry.resolveEntry(
          "archetype",
          normalizedArchetypeId,
          profileId,
        );
        if (archetypePrompt) {
          return this.appendRepositoryReferenceInventory(archetypePrompt.content, descriptor);
        }
      }
    }

    try {
      return this.appendRepositoryReferenceInventory(
        await this.options.promptRegistry.resolve("archetype", "worker", profileId),
        descriptor
      );
    } catch (error) {
      this.options.logDebug("prompt:resolve:fallback", {
        category: "archetype",
        promptId: "worker",
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.appendRepositoryReferenceInventory(DEFAULT_WORKER_SYSTEM_PROMPT, descriptor);
    }
  }

  private async appendRepositoryReferenceInventory(systemPrompt: string, descriptor: AgentDescriptor): Promise<string> {
    const managerDescriptor = descriptor.role === "manager"
      ? descriptor
      : this.options.descriptors.get(descriptor.managerId);
    if (isCollabSession(descriptor) || (managerDescriptor && isCollabSession(managerDescriptor))) {
      return systemPrompt;
    }

    try {
      const profileId = managerDescriptor?.profileId ?? descriptor.profileId ?? descriptor.managerId ?? descriptor.agentId;
      const sessionAgentId = managerDescriptor?.agentId ?? (descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId);
      const cwd = managerDescriptor?.cwd ?? descriptor.cwd;
      const resolver = new ProjectWorkspaceResolver({
        dataDir: this.options.config.paths.dataDir,
        settingsStore: new ProjectResourceSettingsStore(this.options.config.paths.dataDir),
      });
      const resolution = await resolver.resolvePassive({
        profileId,
        sessionAgentId,
        cwd,
      });
      if (!resolution.effectiveForgeDirRealpath) {
        return systemPrompt;
      }
      const inventory = await listRepositoryReferenceDocs(resolution.effectiveForgeDirRealpath, { maxFiles: 100 });
      if (inventory.files.length === 0) {
        return systemPrompt;
      }
      const lines = [
        "",
        "# Repository Reference Documents",
        `Repository reference docs are available under ${inventory.rootDir}. Read relevant files on demand; their contents are not injected by default.`,
        "",
        ...inventory.files.map((file) => `- ${file}`),
        ...(inventory.truncated ? ["- … inventory truncated"] : [])
      ];
      return `${systemPrompt.trimEnd()}\n${lines.join("\n")}`;
    } catch (error) {
      this.options.logDebug("repository_reference:inventory:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return systemPrompt;
    }
  }

  private async resolveSpecialistRosterForDescriptor(
    descriptor: AgentDescriptor,
    specialistRegistry: SpecialistRegistryModuleLike,
  ): Promise<ResolvedSpecialistDefinitionLike[]> {
    const targetSpace = this.resolveSpecialistTargetSpace(descriptor);
    if (descriptor.role === "manager") {
      return this.options.resolveSpecialistRosterForManager
        ? this.options.resolveSpecialistRosterForManager(descriptor, targetSpace)
        : specialistRegistry.resolveRoster(descriptor.profileId ?? descriptor.agentId, targetSpace);
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    if (managerDescriptor && this.options.resolveSpecialistRosterForManager) {
      return this.options.resolveSpecialistRosterForManager(managerDescriptor, targetSpace);
    }

    return specialistRegistry.resolveRoster(descriptor.profileId ?? descriptor.agentId, targetSpace);
  }

  private resolveSpecialistTargetSpace(descriptor: AgentDescriptor): SpecialistTargetSpace {
    if (descriptor.role === "manager") {
      return isCollabSession(descriptor) ? "collaboration" : "builder";
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    return managerDescriptor && isCollabSession(managerDescriptor) ? "collaboration" : "builder";
  }

  private async resolveSkillMetadataForDescriptor(descriptor: AgentDescriptor): Promise<SkillMetadata[]> {
    const resolved = await this.options.resolveSkillRosterForDescriptor?.(descriptor);
    if (resolved) {
      return resolved;
    }

    await this.options.skillMetadataService.ensureSkillMetadataLoaded();
    return this.options.skillMetadataService.getSkillMetadata();
  }

  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string {
    if (descriptor.role !== "worker") {
      return systemPrompt;
    }

    const identityBlock = [
      "",
      "# Agent Identity",
      `- Your agent ID: \`${descriptor.agentId}\``,
      `- Your manager ID: \`${descriptor.managerId}\``,
      "- Always use your manager ID above when sending messages back via send_message_to_agent.",
      "- Do NOT guess the manager ID from list_agents — use the ID provided here.",
    ].join("\n");

    return systemPrompt + identityBlock;
  }

  async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<MemoryRuntimeResources> {
    const memoryOwnerAgentId = this.options.resolveMemoryOwnerAgentId(descriptor);
    const memoryFilePath = this.options.getAgentMemoryPath(memoryOwnerAgentId);

    const memoryOwnerDescriptor = this.options.descriptors.get(memoryOwnerAgentId);
    if (memoryOwnerDescriptor?.role === "manager") {
      await this.options.ensureAgentMemoryFile(
        memoryFilePath,
        normalizeOptionalAgentId(memoryOwnerDescriptor.profileId) ?? memoryOwnerDescriptor.agentId,
      );
    }

    const sessionMemoryContent = await readFile(memoryFilePath, "utf8");
    let memoryContent = sessionMemoryContent;

    const profileMemoryOwnerId = this.options.resolveSessionProfileId(memoryOwnerAgentId);
    if (profileMemoryOwnerId) {
      const profileMemoryPath = getProfileMemoryPath(this.options.config.paths.dataDir, profileMemoryOwnerId);
      await this.options.ensureAgentMemoryFile(profileMemoryPath, profileMemoryOwnerId);
      const profileMemoryContent = await readFile(profileMemoryPath, "utf8");
      memoryContent = buildSessionMemoryRuntimeView(profileMemoryContent, sessionMemoryContent);
    }

    const commonKnowledgePath = getCommonKnowledgePath(this.options.config.paths.dataDir);
    try {
      const commonKnowledgeContent = (await readFile(commonKnowledgePath, "utf8")).trim();
      if (commonKnowledgeContent.length > 0) {
        const baseMemoryContent = memoryContent.trimEnd();
        memoryContent = [
          baseMemoryContent,
          "",
          "---",
          "",
          COMMON_KNOWLEDGE_MEMORY_HEADER,
          "",
          commonKnowledgeContent,
        ].join("\n");
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    if (
      descriptor.role === "manager" &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") !== CORTEX_ARCHETYPE_ID
    ) {
      const onboardingSnapshot = await getOnboardingSnapshot(this.options.config.paths.dataDir);
      if (shouldInjectOnboardingSnapshot(onboardingSnapshot)) {
        memoryContent = [
          memoryContent.trimEnd(),
          "",
          "---",
          "",
          buildOnboardingSnapshotMemoryBlock(onboardingSnapshot).trimEnd(),
        ].join("\n");
      }
    }

    const skillMetadata = await this.resolveSkillMetadataForDescriptor(descriptor);

    if (descriptor.role === "manager") {
      await this.options.refreshSessionMetaStats(descriptor);
    } else {
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);
    }

    return {
      memoryContextFile: {
        path: memoryFilePath,
        content: memoryContent,
      },
      additionalSkillPaths: skillMetadata.map((skill) => skill.path),
      skillMetadata,
    };
  }

  private async getActiveWorkPromptPreviewSection(
    _descriptor: AgentDescriptor & { role: "manager"; profileId: string },
  ): Promise<PromptPreviewSection | undefined> {
    return undefined;
  }

  async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8"),
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.options.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  async buildClaudeRuntimeSystemPrompt(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<string> {
    const runtimeMemoryFilePath = this.options.getAgentMemoryPath(descriptor.agentId);
    const resolvedBasePrompt = resolvePromptVariables(
      systemPrompt,
      this.buildRuntimePromptVariables(runtimeMemoryFilePath),
    );
    const [memoryResources, agentsMdPaths, swarmContextFiles] = await Promise.all([
      this.getMemoryRuntimeResources(descriptor),
      discoverAgentsMd(descriptor.cwd),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);

    return await assembleClaudePrompt({
      basePrompt: resolvedBasePrompt,
      memoryContextFile: memoryResources.memoryContextFile,
      agentsMdPaths: [...agentsMdPaths, ...swarmContextFiles.map((entry) => entry.path)],
      availableSkills: memoryResources.skillMetadata.map((skill) => ({
        name: skill.skillName,
        description: skill.description ?? "",
        location: skill.path,
      })),
      role: descriptor.role,
      agentId: descriptor.agentId,
      cwd: descriptor.cwd,
    });
  }

  async buildCursorSdkRuntimeSystemPrompt(
    descriptor: AgentDescriptor,
    systemPrompt: string,
  ): Promise<string> {
    const runtimeMemoryFilePath = this.options.getAgentMemoryPath(descriptor.agentId);
    const resolvedBasePrompt = resolvePromptVariables(
      systemPrompt,
      this.buildRuntimePromptVariables(runtimeMemoryFilePath),
    );
    const [memoryResources, agentsMdPaths, swarmContextFiles] = await Promise.all([
      this.getMemoryRuntimeResources(descriptor),
      discoverAgentsMd(descriptor.cwd),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);

    const assembledPrompt = await assembleClaudePrompt({
      basePrompt: resolvedBasePrompt,
      memoryContextFile: memoryResources.memoryContextFile,
      agentsMdPaths: [...agentsMdPaths, ...swarmContextFiles.map((entry) => entry.path)],
      availableSkills: memoryResources.skillMetadata.map((skill) => ({
        name: skill.skillName,
        description: skill.description ?? "",
        location: skill.path,
      })),
      role: descriptor.role,
      agentId: descriptor.agentId,
      cwd: descriptor.cwd,
    });

    return [assembledPrompt, CURSOR_SDK_RUNTIME_GUIDANCE_BLOCK].filter((section) => section.trim().length > 0).join("\n\n");
  }

  private buildStandardPromptVariables(descriptor: AgentDescriptor): Record<string, string> {
    return {
      ...this.buildRuntimePromptVariables(this.options.getAgentMemoryPath(descriptor.agentId)),
      ACTIVE_WORK_PLANS_GUIDANCE: this.resolveActiveWorkPlansGuidance(descriptor),
    };
  }

  private resolveActiveWorkPlansGuidance(_descriptor: AgentDescriptor): string {
    return "";
  }

  private buildRuntimePromptVariables(memoryFilePath: string): Record<string, string> {
    return {
      SWARM_DATA_DIR: this.options.config.paths.dataDir,
      SWARM_MEMORY_FILE: memoryFilePath,
      SWARM_SCRIPTS_DIR: join(
        this.options.config.paths.rootDir,
        "apps",
        "backend",
        "src",
        "swarm",
        "scripts",
      ),
    };
  }

  async resolveProjectAgentPromptComposition(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<ProjectAgentPromptComposition> {
    if (!descriptor.projectAgent?.handle) {
      throw new Error(`Agent ${descriptor.agentId} is not a project agent`);
    }

    const base = await this.resolveProjectAgentBasePrompt();
    const sources: ProjectAgentPromptSource[] = [base.source];
    let rolePrompt: string | undefined;

    if (!options?.ignoreProjectAgentSystemPrompt) {
      const normalizedSessionSystemPrompt = normalizeOptionalAgentId(descriptor.sessionSystemPrompt)?.trim();
      if (normalizedSessionSystemPrompt) {
        rolePrompt = normalizedSessionSystemPrompt;
        sources.push({ kind: "session_system_prompt", agentId: descriptor.agentId });
      } else {
        const role = await this.resolveProjectAgentRolePrompt(descriptor);
        rolePrompt = role.prompt;
        if (role.source) {
          sources.push(role.source);
        }
      }
    }

    if (!rolePrompt) {
      sources.push({ kind: "base_only" });
      return {
        content: base.content.trimEnd(),
        sources,
      };
    }

    return {
      content: `${base.content.trimEnd()}\n\n# Project Agent Role Instructions\n\n${rolePrompt.trim()}`,
      rolePrompt,
      sources,
    };
  }

  async resolveProjectAgentSystemPromptOverride(
    descriptor: AgentDescriptor,
    options?: { ignoreProjectAgentSystemPrompt?: boolean },
  ): Promise<{ prompt: string | undefined; sourcePath: string | undefined }> {
    if (options?.ignoreProjectAgentSystemPrompt || !descriptor.projectAgent?.handle) {
      return {
        prompt: undefined,
        sourcePath: undefined,
      };
    }

    const role = await this.resolveProjectAgentRolePrompt(descriptor);
    return {
      prompt: role.prompt,
      sourcePath: role.source && "sourcePath" in role.source ? role.source.sourcePath : undefined,
    };
  }

  private async resolveProjectAgentBasePrompt(): Promise<{ content: string; source: ProjectAgentPromptSource }> {
    try {
      const content = await this.options.promptRegistry.resolveAtLayer(
        "operational",
        PROJECT_AGENT_BASE_PROMPT_ID,
        "builtin",
      );
      if (content?.trim()) {
        return {
          content,
          source: { kind: "project_agent_base" },
        };
      }
    } catch (error) {
      this.options.logDebug("project_agent:base_prompt:resolve_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      content: PROJECT_AGENT_BASE_FALLBACK,
      source: { kind: "project_agent_base", fallback: true },
    };
  }

  private async resolveProjectAgentRolePrompt(
    descriptor: AgentDescriptor,
  ): Promise<{ prompt: string | undefined; source?: ProjectAgentPromptSource }> {
    if (!descriptor.projectAgent?.handle) {
      return { prompt: undefined };
    }

    if (isRepoProjectAgentSource(descriptor.projectAgent.source)) {
      const scope = this.buildProjectAgentReferenceScope(descriptor);
      const resolution = await resolveRepoProjectAgentSource(scope, { dataDir: this.options.config.paths.dataDir });
      const definition = assertRepoProjectAgentSourceAvailable(resolution);
      const prompt = definition.prompt.trim() || undefined;
      return {
        prompt,
        source: prompt
          ? { kind: "repo_prompt", sourcePath: join(definition.dirPath, "prompt.md"), definitionId: definition.config.handle }
          : undefined,
      };
    }

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const onDiskRecord = await this.readOwnedProjectAgentRecord(descriptor, profileId);
    if (onDiskRecord?.systemPrompt !== null && onDiskRecord?.systemPrompt !== undefined) {
      const prompt = onDiskRecord.systemPrompt.trim() || undefined;
      return {
        prompt,
        source: prompt
          ? {
              kind: "profile_prompt",
              sourcePath: getProjectAgentPromptPath(this.options.config.paths.dataDir, profileId, onDiskRecord.config.handle),
              handle: onDiskRecord.config.handle,
            }
          : undefined,
      };
    }

    const prompt = descriptor.projectAgent.systemPrompt?.trim() || undefined;
    return {
      prompt,
      source: prompt ? { kind: "descriptor_fallback", handle: descriptor.projectAgent.handle } : undefined,
    };
  }

  private formatProjectAgentPromptSources(sources: ProjectAgentPromptSource[]): string {
    return sources.map((source) => {
      switch (source.kind) {
        case "project_agent_base":
          return source.fallback ? "project-agent-base:fallback" : "project-agent-base";
        case "session_system_prompt":
          return `sessionSystemPrompt:${source.agentId}`;
        case "repo_prompt":
        case "profile_prompt":
          return source.sourcePath;
        case "descriptor_fallback":
          return `project-agent-descriptor:${source.handle}`;
        case "base_only":
          return "base-only";
      }
    }).join(" + ");
  }

  private async resolveProjectAgentReferenceDocs(
    descriptor: AgentDescriptor,
    profileId: string,
  ): Promise<Array<{ path: string; content: string }>> {
    if (!descriptor.projectAgent?.handle) {
      return [];
    }

    if (isRepoProjectAgentSource(descriptor.projectAgent.source)) {
      const scope = this.buildProjectAgentReferenceScope(descriptor);
      const resolution = await resolveRepoProjectAgentSource(scope, { dataDir: this.options.config.paths.dataDir });
      const definition = assertRepoProjectAgentSourceAvailable(resolution);
      return definition.referenceDocs.map((doc) => ({ path: doc.path, content: doc.content }));
    }

    const projectAgentRecord = await this.readOwnedProjectAgentRecord(descriptor, profileId);
    if (!projectAgentRecord) {
      return [];
    }

    const refDocFiles = await listProjectAgentReferenceDocs(
      this.options.config.paths.dataDir,
      profileId,
      projectAgentRecord.config.handle,
    );
    const refContents: Array<{ path: string; content: string }> = [];
    for (const fileName of refDocFiles) {
      const content = await readProjectAgentReferenceDoc(
        this.options.config.paths.dataDir,
        profileId,
        projectAgentRecord.config.handle,
        fileName,
      );
      if (content) {
        refContents.push({ path: fileName, content });
      }
    }

    return refContents;
  }

  private buildProjectAgentReferenceScope(descriptor: AgentDescriptor) {
    if (!descriptor.projectAgent?.handle) {
      throw new Error(`Agent ${descriptor.agentId} is not a project agent`);
    }

    return {
      descriptor: descriptor as AgentDescriptor & {
        role: "manager";
        profileId: string;
        projectAgent: NonNullable<AgentDescriptor["projectAgent"]>;
      },
      profileId: descriptor.profileId ?? descriptor.agentId,
      handle: descriptor.projectAgent.handle,
    };
  }

  private async readOwnedProjectAgentRecord(
    descriptor: AgentDescriptor,
    profileId: string,
  ): Promise<ProjectAgentOnDiskRecord | null> {
    if (!descriptor.projectAgent?.handle || isRepoProjectAgentSource(descriptor.projectAgent.source)) {
      return null;
    }

    const onDiskRecord = await readProjectAgentRecord(
      this.options.config.paths.dataDir,
      profileId,
      descriptor.projectAgent.handle,
    );
    if (!onDiskRecord) {
      return null;
    }

    if (onDiskRecord.config.agentId !== descriptor.agentId) {
      console.warn(
        `[swarm] prompt-service:skip_foreign_project_agent_record profile=${profileId} agentId=${descriptor.agentId} handle=${descriptor.projectAgent.handle} ownerAgentId=${onDiskRecord.config.agentId}`,
      );
      return null;
    }

    return onDiskRecord;
  }

  private async appendCollabContextOverlays(descriptor: AgentDescriptor, basePrompt: string): Promise<string> {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const dataDir = this.options.config.paths.dataDir;
    const promptPath = getSessionContextPromptPath(dataDir, profileId, descriptor.agentId);
    const referenceDocs = await this.resolveCollabReferenceDocs(dataDir, profileId, descriptor.agentId);
    const sections: string[] = [basePrompt.trimEnd()];

    sections.push(`# Collaboration channel instructions\n\n${COLLABORATION_CHANNEL_INSTRUCTIONS}`);

    const contextPrompt = (await readPromptFile(promptPath))?.trim();
    if (contextPrompt) {
      sections.push(`# Additional instructions\n\n${contextPrompt}`);
    }

    for (const referenceDoc of referenceDocs.docs) {
      const content = (await readReferenceDoc(referenceDocs.dir, referenceDoc.fileName))?.trim();
      if (!content) {
        continue;
      }

      sections.push(`# Channel Reference: ${referenceDoc.fileName}\n\n${content}`);
    }

    return sections.join("\n\n");
  }

  private async resolveCollabReferenceDocs(
    dataDir: string,
    profileId: string,
    sessionAgentId: string,
  ): Promise<{ dir: string; docs: Awaited<ReturnType<typeof listReferenceDocs>> }> {
    const referenceDir = getSessionReferenceDir(dataDir, profileId, sessionAgentId);
    const legacyReferenceDir = getSessionContextReferenceDir(dataDir, profileId, sessionAgentId);

    let docs = await listReferenceDocs(referenceDir);
    if (docs.length > 0) {
      return { dir: referenceDir, docs };
    }

    const legacyDocs = await listReferenceDocs(legacyReferenceDir);
    if (legacyDocs.length === 0) {
      return { dir: referenceDir, docs };
    }

    try {
      await mkdir(referenceDir, { recursive: true });
      for (const legacyDoc of legacyDocs) {
        const targetExists = existsSync(join(referenceDir, legacyDoc.fileName));
        if (!targetExists) {
          await copyFile(legacyDoc.path, join(referenceDir, legacyDoc.fileName));
        }
      }
      docs = await listReferenceDocs(referenceDir);
      if (docs.length > 0) {
        return { dir: referenceDir, docs };
      }
    } catch (error) {
      this.options.logDebug("collaboration:reference:migration:error", {
        profileId,
        sessionAgentId,
        referenceDir,
        legacyReferenceDir,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return { dir: legacyReferenceDir, docs: legacyDocs };
  }

  private async appendAvailableSkillsBlock(systemPrompt: string, descriptor: AgentDescriptor): Promise<string> {
    const allSkillMetadata = await this.resolveSkillMetadataForDescriptor(descriptor);
    if (allSkillMetadata.length === 0) {
      return systemPrompt;
    }

    const skillLines = [
      "",
      "",
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
    ];
    for (const skill of allSkillMetadata) {
      skillLines.push("  <skill>");
      skillLines.push(`    <name>${escapeXmlForPreview(skill.skillName)}</name>`);
      if (skill.description) {
        skillLines.push(`    <description>${escapeXmlForPreview(skill.description)}</description>`);
      }
      skillLines.push(`    <location>${escapeXmlForPreview(skill.path)}</location>`);
      skillLines.push("  </skill>");
    }
    skillLines.push("</available_skills>");
    return systemPrompt.trimEnd() + skillLines.join("\n");
  }
}

function isSessionAgent(
  descriptor: AgentDescriptor | undefined,
): descriptor is AgentDescriptor & { role: "manager"; profileId: string } {
  return (
    !!descriptor &&
    descriptor.role === "manager" &&
    typeof descriptor.profileId === "string" &&
    descriptor.profileId.trim().length > 0
  );
}

function hasOnboardingPreferenceValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function shouldInjectOnboardingSnapshot(snapshot: Awaited<ReturnType<typeof getOnboardingSnapshot>>): boolean {
  return (
    snapshot.status === "completed" &&
    (hasOnboardingPreferenceValue(snapshot.preferences?.preferredName) ||
      snapshot.preferences?.technicalLevel !== null ||
      hasOnboardingPreferenceValue(snapshot.preferences?.additionalPreferences))
  );
}

function humanizeOnboardingTechnicalLevel(
  value: NonNullable<NonNullable<Awaited<ReturnType<typeof getOnboardingSnapshot>>["preferences"]>["technicalLevel"]>,
): string {
  switch (value) {
    case "developer":
      return "developer";
    case "technical_non_developer":
      return "technical (non-developer)";
    case "semi_technical":
      return "semi-technical";
    case "non_technical":
      return "non-technical";
    default:
      return value;
  }
}

function buildOnboardingSnapshotMemoryBlock(
  snapshot: Awaited<ReturnType<typeof getOnboardingSnapshot>>,
): string {
  const lines = [ONBOARDING_SNAPSHOT_MEMORY_HEADER, "", `- status: ${snapshot.status}`];

  if (snapshot.preferences?.preferredName) {
    lines.push(`- preferred name: ${snapshot.preferences.preferredName}`);
  }

  if (snapshot.preferences?.technicalLevel) {
    lines.push(`- technical level: ${humanizeOnboardingTechnicalLevel(snapshot.preferences.technicalLevel)}`);
  }

  if (snapshot.preferences?.additionalPreferences) {
    lines.push(
      `- additional preferences: ${snapshot.preferences.additionalPreferences
        .replace(/\s+/g, " ")
        .trim()}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
