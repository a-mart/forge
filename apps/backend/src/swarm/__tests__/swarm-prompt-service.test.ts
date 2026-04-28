import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileBackedPromptRegistry } from "../prompts/prompt-registry.js";
import { writeProjectAgentRecord } from "../project-agent-storage.js";
import { writeReferenceDoc } from "../storage/asset-root-storage.js";
import { SwarmPromptService } from "../swarm-prompt-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";
import {
  getCommonKnowledgePath,
  getProfileMemoryPath,
  getSessionContextPromptPath,
  getSessionContextReferenceDir,
  resolveMemoryFilePath,
} from "../data-paths.js";
import type { PersistedProjectAgentConfig } from "@forge/protocol";
import { createTempConfig, type TempConfigHandle } from "../../test-support/index.js";

const repoRoot = resolve(process.cwd(), "../..");
const BUILTIN_ARCHETYPES = join(
  repoRoot,
  "apps",
  "backend",
  "src",
  "swarm",
  "archetypes",
  "builtins"
);
const BUILTIN_OPERATIONAL = join(repoRoot, "apps", "backend", "src", "swarm", "operational", "builtins");

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

async function makeConfig(): Promise<{ config: SwarmConfig; cleanup: () => Promise<void> }> {
  const handle = await createTempConfig({
    prefix: "swarm-prompt-service-",
    port: 0,
    rootDir: repoRoot,
    resourcesDir: repoRoot,
    defaultCwd: repoRoot,
    cwdAllowlistRoots: [repoRoot],
    repoArchetypesDir: BUILTIN_ARCHETYPES,
    repoMemorySkillFile: join(
      repoRoot,
      "apps",
      "backend",
      "src",
      "swarm",
      "skills",
      "builtins",
      "memory",
      "SKILL.md"
    ),
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium"
    }
  });
  tempHandles.push(handle);
  return { config: handle.config, cleanup: handle.cleanup };
}

function createManagerDescriptor(
  config: SwarmConfig,
  cwd: string,
  overrides: Partial<AgentDescriptor> = {}
): AgentDescriptor & { role: "manager"; profileId: string } {
  const agentId = overrides.agentId ?? "manager";
  const profileId = overrides.profileId ?? "manager";
  return {
    agentId,
    displayName: "Manager",
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd,
    archetypeId: "manager",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium"
    },
    sessionFile: join(config.paths.sessionsDir, `${agentId}.jsonl`),
    ...overrides
  } as AgentDescriptor & { role: "manager"; profileId: string };
}

function createProfile(defaultSessionAgentId: string): ManagerProfile {
  return {
    profileId: "manager",
    displayName: "Manager",
    defaultSessionAgentId,
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "medium"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

async function ensureMemoryFile(memoryFilePath: string, content: string): Promise<void> {
  await mkdir(dirname(memoryFilePath), { recursive: true });
  await writeFile(memoryFilePath, content, "utf8");
}

function specialistRegistryStub() {
  return {
    resolveRoster: vi.fn(async () => []),
    generateRosterBlock: vi.fn(() => ""),
    getSpecialistsEnabled: vi.fn(async () => false),
    legacyModelRoutingGuidance: "Legacy routing guidance for tests."
  };
}

describe("SwarmPromptService", () => {
  it("previewManagerSystemPrompt assembles System Prompt, Memory Composite, AGENTS.md, and SWARM.md sections", async () => {
    const { config } = await makeConfig();
    const workRoot = join(config.paths.dataDir, "work-preview");
    const outer = join(workRoot, "outer");
    const inner = join(outer, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "AGENTS.md"), "# Local AGENTS\n", "utf8");
    await writeFile(join(workRoot, "SWARM.md"), "# Root swarm policy\n", "utf8");
    await writeFile(join(outer, "SWARM.md"), "# Repo swarm policy\n", "utf8");

    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const sessionMemoryPath = resolveMemoryFilePath(
      dataDir,
      { agentId: "manager", role: "manager", profileId, managerId: "manager" },
      undefined
    );
    const profileMemoryPath = getProfileMemoryPath(dataDir, profileId);
    await ensureMemoryFile(sessionMemoryPath, "# Session mem\n");
    await ensureMemoryFile(profileMemoryPath, "# Profile mem\n");
    const commonPath = getCommonKnowledgePath(dataDir);
    await mkdir(dirname(commonPath), { recursive: true });
    await writeFile(commonPath, "", "utf8");

    const descriptor = createManagerDescriptor(config, inner);
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile("manager")]]);
    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);

    const promptRegistry = new FileBackedPromptRegistry({
      dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });

    const refreshStats = vi.fn(async () => {});
    const service = new SwarmPromptService({
      config,
      descriptors,
      profiles,
      promptRegistry,
      skillMetadataService: {
        ensureSkillMetadataLoaded: async () => {},
        getSkillMetadata: () => [],
        getAdditionalSkillPaths: () => []
      } as never,
      getAgentMemoryPath: (agentId) =>
        resolveMemoryFilePath(
          dataDir,
          { agentId, role: "manager", profileId: "manager", managerId: agentId },
          undefined
        ),
      ensureAgentMemoryFile: async (path) => {
        await mkdir(dirname(path), { recursive: true });
        try {
          await readFile(path);
        } catch {
          await writeFile(path, "# m\n", "utf8");
        }
      },
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => "manager",
      refreshSessionMetaStats: refreshStats,
      refreshSessionMetaStatsBySessionId: refreshStats,
      getSessionsForProfile: () => [descriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const preview = await service.previewManagerSystemPrompt("manager");
    const labels = preview.sections.map((s) => s.label);
    expect(labels[0]).toBe("System Prompt");
    expect(labels[1]).toBe("Memory Composite");
    expect(labels).toContain("AGENTS.md");
    expect(labels.filter((l) => l === "SWARM.md").length).toBe(2);

    const agentsSection = preview.sections.find((s) => s.label === "AGENTS.md");
    expect(agentsSection?.content).toContain("Local AGENTS");
    const swarmBodies = preview.sections.filter((s) => s.label === "SWARM.md").map((s) => s.content.trim());
    expect(swarmBodies.some((body) => body.includes("Root swarm policy"))).toBe(true);
    expect(swarmBodies.some((body) => body.includes("Repo swarm policy"))).toBe(true);

    expect(refreshStats).toHaveBeenCalled();
  });

  it("buildResolvedManagerPrompt inserts model-specific instructions for catalog models", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot);
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile("manager")]]);
    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);

    const promptRegistry = new FileBackedPromptRegistry({
      dataDir: config.paths.dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });

    const service = new SwarmPromptService({
      config,
      descriptors,
      profiles,
      promptRegistry,
      skillMetadataService: {} as never,
      getAgentMemoryPath: () => "/tmp/memory.md",
      ensureAgentMemoryFile: async () => {},
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => "manager",
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [descriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).toContain("# Model-Specific Instructions");
    expect(resolved).toContain("Return the requested sections only");
    expect(resolved).toContain("Legacy routing guidance for tests.");
  });

  it("previewManagerSystemPromptForAgent uses the requested collab session and appends session context overlays", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const defaultDescriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "default-manager",
      profileId,
      archetypeId: "manager",
    });
    const collabDescriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "collab-preview",
      profileId,
      archetypeId: "collaboration-channel",
      sessionSurface: "collab",
      collab: {
        workspaceId: "workspace-1",
        channelId: "channel-1",
      },
    });
    const profiles = new Map<string, ManagerProfile>([[profileId, createProfile(defaultDescriptor.agentId)]]);
    const descriptors = new Map<string, AgentDescriptor>([
      [defaultDescriptor.agentId, defaultDescriptor],
      [collabDescriptor.agentId, collabDescriptor],
    ]);

    const defaultSessionMemoryPath = resolveMemoryFilePath(
      dataDir,
      { agentId: defaultDescriptor.agentId, role: "manager", profileId, managerId: defaultDescriptor.agentId },
      undefined
    );
    const collabSessionMemoryPath = resolveMemoryFilePath(
      dataDir,
      { agentId: collabDescriptor.agentId, role: "manager", profileId, managerId: collabDescriptor.agentId },
      undefined
    );
    const profileMemoryPath = getProfileMemoryPath(dataDir, profileId);
    const collabPromptPath = getSessionContextPromptPath(dataDir, profileId, collabDescriptor.agentId);
    const collabReferenceDir = getSessionContextReferenceDir(dataDir, profileId, collabDescriptor.agentId);
    await ensureMemoryFile(defaultSessionMemoryPath, "# Default session mem\n");
    await ensureMemoryFile(collabSessionMemoryPath, "# Collaboration session mem\n");
    await ensureMemoryFile(profileMemoryPath, "# Profile mem\n");
    await mkdir(dirname(collabPromptPath), { recursive: true });
    await writeFile(collabPromptPath, "Collaboration-specific prompt overlay", "utf8");
    await writeReferenceDoc(collabReferenceDir, "playbook.md", "Use the escalation playbook.");

    const promptRegistry = new FileBackedPromptRegistry({
      dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });

    const service = new SwarmPromptService({
      config,
      descriptors,
      profiles,
      promptRegistry,
      skillMetadataService: {
        ensureSkillMetadataLoaded: async () => {},
        getSkillMetadata: () => [{ skillName: "memory", description: "Memory skill", path: "/tmp/memory/SKILL.md" }],
        getAdditionalSkillPaths: () => []
      } as never,
      getAgentMemoryPath: (agentId) =>
        resolveMemoryFilePath(
          dataDir,
          { agentId, role: "manager", profileId, managerId: agentId },
          undefined
        ),
      ensureAgentMemoryFile: async (path) => {
        await mkdir(dirname(path), { recursive: true });
        try {
          await readFile(path);
        } catch {
          await writeFile(path, "# m\n", "utf8");
        }
      },
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => profileId,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [defaultDescriptor, collabDescriptor],
      loadSpecialistRegistryModule: async () => ({
        resolveRoster: async () => [],
        generateRosterBlock: () => "Specialist roster block",
        getSpecialistsEnabled: async () => true,
        legacyModelRoutingGuidance: "Legacy routing guidance for tests."
      }),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const defaultPreview = await service.previewManagerSystemPrompt(profileId);
    const defaultSystemPrompt = defaultPreview.sections[0]?.content ?? "";
    expect(defaultSystemPrompt).not.toContain("# Collaboration channel instructions");
    expect(defaultSystemPrompt).not.toContain("Collaboration-specific prompt overlay");

    const preview = await service.previewManagerSystemPromptForAgent(collabDescriptor.agentId);
    const systemPrompt = preview.sections[0]?.content ?? "";
    const memoryComposite = preview.sections[1]?.content ?? "";

    expect(systemPrompt).toContain("You are the manager agent for a collaboration channel in a multi-agent swarm.");
    expect(systemPrompt).toContain("Specialist roster block");
    expect(systemPrompt).toContain("# Collaboration channel instructions");
    expect(systemPrompt).toContain("# Additional instructions\n\nCollaboration-specific prompt overlay");
    expect(systemPrompt).toContain("# Channel Reference: playbook.md\n\nUse the escalation playbook.");
    expect(systemPrompt).toContain("<available_skills>");
    expect(systemPrompt).toContain("<name>memory</name>");
    expect(memoryComposite).toContain("Collaboration session mem");
    expect(memoryComposite).not.toContain("Default session mem");
  });

  it("resolveProjectAgentSystemPromptOverride prefers on-disk project agent prompt.md", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const handle = "pa-test";

    const paConfig: PersistedProjectAgentConfig = {
      version: 1,
      agentId: "agent-1",
      handle,
      whenToUse: "testing",
      promotedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    };
    await writeProjectAgentRecord(dataDir, profileId, paConfig, "On-disk override body for tests.");

    const descriptor = createManagerDescriptor(config, repoRoot, {
      projectAgent: {
        handle,
        whenToUse: "test"
      }
    });

    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      profiles: new Map([[profileId, createProfile(descriptor.agentId)]]),
      promptRegistry: {} as never,
      skillMetadataService: {} as never,
      getAgentMemoryPath: () => "/tmp/memory.md",
      ensureAgentMemoryFile: async () => {},
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => profileId,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [descriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const resolved = await service.resolveProjectAgentSystemPromptOverride(descriptor);
    expect(resolved.prompt).toBe("On-disk override body for tests.");
    expect(resolved.sourcePath).toMatch(/prompt\.md$/);
  });

  it("getSwarmContextFiles walks parent directories and returns nearest-first ordering", async () => {
    const { config } = await makeConfig();
    const base = join(config.paths.dataDir, "swarm-ctx");
    const level1 = join(base, "a");
    const level2 = join(level1, "b");
    await mkdir(level2, { recursive: true });
    await writeFile(join(level1, "SWARM.md"), "level1", "utf8");
    await writeFile(join(base, "SWARM.md"), "root", "utf8");

    const service = new SwarmPromptService({
      config,
      descriptors: new Map(),
      profiles: new Map(),
      promptRegistry: {} as never,
      skillMetadataService: {} as never,
      getAgentMemoryPath: () => "/tmp/m.md",
      ensureAgentMemoryFile: async () => {},
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => undefined,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const files = await service.getSwarmContextFiles(level2);
    expect(files.map((f) => f.content.trim())).toEqual(["root", "level1"]);
  });

  it("getMemoryRuntimeResources builds composite memory with profile + session and common knowledge", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const sessionPath = resolveMemoryFilePath(
      dataDir,
      { agentId: "manager", role: "manager", profileId, managerId: "manager" },
      undefined
    );
    const profilePath = getProfileMemoryPath(dataDir, profileId);
    await ensureMemoryFile(sessionPath, "## Session line\n");
    await ensureMemoryFile(profilePath, "## Profile line\n");
    const commonPath = getCommonKnowledgePath(dataDir);
    await mkdir(dirname(commonPath), { recursive: true });
    await writeFile(commonPath, "Common fact", "utf8");

    const descriptor = createManagerDescriptor(config, repoRoot, { archetypeId: "cortex" });
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile("manager")]]);
    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);

    const service = new SwarmPromptService({
      config,
      descriptors,
      profiles,
      promptRegistry: {} as never,
      skillMetadataService: {
        ensureSkillMetadataLoaded: async () => {},
        getSkillMetadata: () => [],
        getAdditionalSkillPaths: () => []
      } as never,
      getAgentMemoryPath: (agentId) =>
        resolveMemoryFilePath(
          dataDir,
          { agentId, role: "manager", profileId, managerId: agentId },
          undefined
        ),
      ensureAgentMemoryFile: async (path) => {
        await mkdir(dirname(path), { recursive: true });
        try {
          await readFile(path);
        } catch {
          await writeFile(path, "# x\n", "utf8");
        }
      },
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => profileId,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [descriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const resources = await service.getMemoryRuntimeResources(descriptor);
    expect(resources.memoryContextFile.path).toBe(sessionPath);
    expect(resources.memoryContextFile.content).toContain("Manager Memory");
    expect(resources.memoryContextFile.content).toContain("Profile line");
    expect(resources.memoryContextFile.content).toContain("Session line");
    expect(resources.memoryContextFile.content).toContain("Common Knowledge");
    expect(resources.memoryContextFile.content).toContain("Common fact");
  });
});
