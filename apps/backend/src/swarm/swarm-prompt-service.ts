import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PromptPreviewResponse, PromptPreviewSection } from "@forge/protocol";
import { assembleClaudePrompt, discoverAgentsMd } from "./claude-prompt-assembler.js";
import {
  getCommonKnowledgePath,
  getProfileMemoryPath,
  getProjectAgentPromptPath,
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
} from "./project-agents.js";
import { readProjectAgentRecord } from "./project-agent-storage.js";
import {
  listProjectAgentReferenceDocs,
  readProjectAgentReferenceDoc,
} from "./reference-docs.js";
import type { SkillMetadataService } from "./skill-metadata-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "./types.js";
import {
  buildSessionMemoryRuntimeView,
  escapeXmlForPreview,
  isEnoentError,
  normalizeOptionalAgentId,
} from "./swarm-manager-utils.js";

const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users only see messages they send and manager speak_to_user outputs.
- Your plain assistant text is not directly visible to end users.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at \${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.`;
const MANAGER_ARCHETYPE_ID = "manager";
const CORTEX_ARCHETYPE_ID = "cortex";
const COMMON_KNOWLEDGE_MEMORY_HEADER =
  "# Common Knowledge (maintained by Cortex — read-only reference)";
const ONBOARDING_SNAPSHOT_MEMORY_HEADER =
  "# Onboarding Snapshot (authoritative backend state — read-only reference)";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const AGENTS_CONTEXT_FILE_NAME = "AGENTS.md";

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  promptBody?: string;
}

interface SpecialistRegistryModuleLike {
  resolveRoster(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  generateRosterBlock(roster: ResolvedSpecialistDefinitionLike[]): string;
  getSpecialistsEnabled(): Promise<boolean>;
  legacyModelRoutingGuidance: string;
}

interface MemoryRuntimeResources {
  memoryContextFile: { path: string; content: string };
  additionalSkillPaths: string[];
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
  loadSpecialistRegistryModule: () => Promise<SpecialistRegistryModuleLike>;
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

    const resolvedProfileId = normalizeOptionalAgentId(descriptor.profileId) ?? profileId;
    const { prompt: projectAgentPrompt, sourcePath: projectAgentPromptSourcePath } =
      await this.resolveProjectAgentSystemPromptOverride(descriptor);
    const archetypeId = descriptor.archetypeId
      ? normalizeArchetypeId(descriptor.archetypeId) || MANAGER_ARCHETYPE_ID
      : MANAGER_ARCHETYPE_ID;
    const archetypeEntry = projectAgentPrompt
      ? undefined
      : await this.options.promptRegistry.resolveEntry("archetype", archetypeId, resolvedProfileId);
    if (!projectAgentPrompt && !archetypeEntry) {
      throw new Error(`Prompt not found: archetype/${archetypeId}`);
    }

    const [resolvedSystemPrompt, memoryResources, swarmContextFiles] = await Promise.all([
      this.resolveSystemPromptForDescriptor(descriptor),
      this.getMemoryRuntimeResources(descriptor),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);
    const systemPrompt = this.appendAvailableSkillsBlock(resolvedSystemPrompt);

    const sections: PromptPreviewSection[] = [
      {
        label: "System Prompt",
        source: projectAgentPrompt ? projectAgentPromptSourcePath! : archetypeEntry!.sourcePath,
        content: systemPrompt,
      },
      {
        label: "Memory Composite",
        source: memoryResources.memoryContextFile.path,
        content: memoryResources.memoryContextFile.content,
      },
    ];

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
    const { prompt: projectAgentPrompt } = await this.resolveProjectAgentSystemPromptOverride(
      descriptor,
      options,
    );
    const [promptTemplate, roster, specialistsEnabled] = await Promise.all([
      projectAgentPrompt
        ? Promise.resolve(projectAgentPrompt)
        : this.options.promptRegistry.resolve("archetype", managerArchetypeId, profileId),
      specialistRegistry.resolveRoster(profileId),
      specialistRegistry.getSpecialistsEnabled(),
    ]);

    const delegationBlock = specialistsEnabled
      ? specialistRegistry.generateRosterBlock(roster)
      : specialistRegistry.legacyModelRoutingGuidance;
    const projectAgentDirectoryBlock = generateProjectAgentDirectoryBlock(
      listProjectAgents(this.options.descriptors.values(), profileId, {
        excludeAgentId: descriptor.agentId,
      }).map((entry) => ({
        agentId: entry.agentId,
        displayName: getProjectAgentPublicName(entry),
        handle: entry.projectAgent.handle,
        whenToUse: entry.projectAgent.whenToUse,
      })),
    );
    const delegationContextBlock = `${delegationBlock}\n\n${projectAgentDirectoryBlock}`;
    let prompt = resolvePromptVariables(promptTemplate, this.buildStandardPromptVariables(descriptor));

    if (descriptor.projectAgent?.handle) {
      const refDocFiles = await listProjectAgentReferenceDocs(
        this.options.config.paths.dataDir,
        profileId,
        descriptor.projectAgent.handle,
      );
      if (refDocFiles.length > 0) {
        const refContents: string[] = [];
        for (const fileName of refDocFiles) {
          const content = await readProjectAgentReferenceDoc(
            this.options.config.paths.dataDir,
            profileId,
            descriptor.projectAgent.handle,
            fileName,
          );
          if (content) {
            refContents.push(`## ${fileName}\n${content}`);
          }
        }
        if (refContents.length > 0) {
          prompt = `${prompt.trimEnd()}\n\n<agent_reference_docs>\n${refContents.join("\n\n")}\n</agent_reference_docs>`;
        }
      }
    }

    if (prompt.includes("${SPECIALIST_ROSTER}")) {
      prompt = prompt.replaceAll("${SPECIALIST_ROSTER}", delegationContextBlock);
    } else {
      prompt = `${prompt.trimEnd()}\n\n${delegationContextBlock}`;
    }

    const modelSpecificInstructionsPlaceholders = [
      "${MODEL_SPECIFIC_INSTRUCTIONS}",
      "${Model_Specific_Instructions}",
      "${model_specific_instructions}",
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

    return prompt;
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
        const roster = await specialistRegistry.resolveRoster(profileId);
        const specialist = roster.find((entry) => entry.specialistId === specialistId);
        const specialistPrompt = specialist?.promptBody?.trim();
        if (specialistPrompt) {
          return specialistPrompt;
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
          return archetypePrompt.content;
        }
      }
    }

    try {
      return await this.options.promptRegistry.resolve("archetype", "worker", profileId);
    } catch (error) {
      this.options.logDebug("prompt:resolve:fallback", {
        category: "archetype",
        promptId: "worker",
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
      return DEFAULT_WORKER_SYSTEM_PROMPT;
    }
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

    await this.options.skillMetadataService.ensureSkillMetadataLoaded();

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
      additionalSkillPaths: this.options.skillMetadataService.getAdditionalSkillPaths(),
    };
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

  async buildCodexRuntimeSystemPrompt(
    descriptor: AgentDescriptor,
    baseSystemPrompt: string,
  ): Promise<string> {
    const [memoryResources, swarmContextFiles] = await Promise.all([
      this.getMemoryRuntimeResources(descriptor),
      this.getSwarmContextFiles(descriptor.cwd),
    ]);

    const sections: string[] = [];
    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----",
        ].join("\n"),
      );
    }

    const memoryContent = memoryResources.memoryContextFile.content.trim();
    if (memoryContent) {
      sections.push(
        [
          `Persistent swarm memory (${memoryResources.memoryContextFile.path}):`,
          "----- BEGIN SWARM MEMORY -----",
          memoryContent,
          "----- END SWARM MEMORY -----",
        ].join("\n"),
      );
    }

    return sections.join("\n\n");
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
      availableSkills: this.options.skillMetadataService.getSkillMetadata().map((skill) => ({
        name: skill.skillName,
        description: skill.description ?? "",
        location: skill.path,
      })),
      role: descriptor.role,
      agentId: descriptor.agentId,
      cwd: descriptor.cwd,
    });
  }

  private buildStandardPromptVariables(descriptor: AgentDescriptor): Record<string, string> {
    return this.buildRuntimePromptVariables(this.options.getAgentMemoryPath(descriptor.agentId));
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

    const profileId = descriptor.profileId ?? descriptor.agentId;
    const sourcePath = getProjectAgentPromptPath(
      this.options.config.paths.dataDir,
      profileId,
      descriptor.projectAgent.handle,
    );
    const onDiskRecord = await readProjectAgentRecord(
      this.options.config.paths.dataDir,
      profileId,
      descriptor.projectAgent.handle,
    );
    let prompt: string | undefined;
    if (onDiskRecord?.systemPrompt !== null && onDiskRecord?.systemPrompt !== undefined) {
      prompt = onDiskRecord.systemPrompt.trim() || undefined;
    } else {
      prompt = descriptor.projectAgent.systemPrompt?.trim() || undefined;
    }

    return {
      prompt,
      sourcePath: prompt ? sourcePath : undefined,
    };
  }

  private appendAvailableSkillsBlock(systemPrompt: string): string {
    const allSkillMetadata = this.options.skillMetadataService.getSkillMetadata();
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
