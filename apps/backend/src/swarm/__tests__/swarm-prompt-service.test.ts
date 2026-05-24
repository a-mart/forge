import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileBackedPromptRegistry } from "../prompts/prompt-registry.js";
import { writeProjectAgentRecord } from "../project-agent-storage.js";
import { writeProjectAgentReferenceDoc } from "../reference-docs.js";
import { writeReferenceDoc } from "../storage/asset-root-storage.js";
import { SwarmPromptService } from "../swarm-prompt-service.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";
import {
  getCommonKnowledgePath,
  getProfileMemoryPath,
  getSessionContextPromptPath,
  getSessionContextReferenceDir,
  getSessionReferenceDir,
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

function fakeSkillMetadata(directoryName: string): SkillMetadata {
  return {
    skillId: directoryName,
    skillName: directoryName,
    directoryName,
    path: `/skills/${directoryName}/SKILL.md`,
    rootPath: `/skills/${directoryName}`,
    env: [],
    sourceKind: "builtin",
    isInherited: false,
    isEffective: true,
  };
}

function specialistRegistryStub() {
  return {
    resolveRoster: vi.fn(async () => []),
    generateRosterBlock: vi.fn(() => ""),
    getSpecialistsEnabled: vi.fn(async () => false),
    legacyModelRoutingGuidance: "Legacy routing guidance for tests."
  };
}

function createPromptRegistry(config: SwarmConfig) {
  return new FileBackedPromptRegistry({
    dataDir: config.paths.dataDir,
    repoDir: config.paths.rootDir,
    builtinArchetypesDir: BUILTIN_ARCHETYPES,
    builtinOperationalDir: BUILTIN_OPERATIONAL
  });
}

function createPromptServiceForDescriptor(config: SwarmConfig, descriptor: AgentDescriptor): SwarmPromptService {
  const profileId = descriptor.profileId ?? descriptor.agentId;
  return new SwarmPromptService({
    config,
    descriptors: new Map([[descriptor.agentId, descriptor]]),
    profiles: new Map([[profileId, createProfile(descriptor.agentId)]]),
    promptRegistry: createPromptRegistry(config),
    skillMetadataService: {
      ensureSkillMetadataLoaded: async () => {},
      getSkillMetadata: () => [],
      getAdditionalSkillPaths: () => []
    } as never,
    getAgentMemoryPath: (agentId) => resolveMemoryFilePath(config.paths.dataDir, { ...descriptor, agentId }, undefined),
    ensureAgentMemoryFile: async (path) => ensureMemoryFile(path, "# m\n"),
    resolveMemoryOwnerAgentId: (d) => d.agentId,
    resolveSessionProfileId: () => profileId,
    refreshSessionMetaStats: async () => {},
    refreshSessionMetaStatsBySessionId: async () => {},
    getSessionsForProfile: () => [descriptor],
    loadSpecialistRegistryModule: async () => specialistRegistryStub(),
    getIntegrationContext: () => undefined,
    logDebug: () => {}
  });
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

  it("buildResolvedManagerPrompt resolves collaboration specialist roster for collab sessions", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      sessionSurface: "collab",
      collab: { workspaceId: "workspace-1", channelId: "channel-1" },
    });
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile("manager")]]);
    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const promptRegistry = new FileBackedPromptRegistry({
      dataDir: config.paths.dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL,
    });
    const specialistRegistry = {
      ...specialistRegistryStub(),
      resolveRoster: vi.fn(async (_profileId: string, targetSpace?: string) =>
        targetSpace === "collaboration"
          ? [{ specialistId: "collab-specialist", promptBody: "Collab prompt" }]
          : [{ specialistId: "builder-specialist", promptBody: "Builder prompt" }],
      ),
      generateRosterBlock: vi.fn((roster: Array<{ specialistId: string }>) =>
        roster.map((entry) => entry.specialistId).join("\n"),
      ),
      getSpecialistsEnabled: vi.fn(async () => true),
    };

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
      loadSpecialistRegistryModule: async () => specialistRegistry,
      getIntegrationContext: () => undefined,
      logDebug: () => {},
    });

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(specialistRegistry.resolveRoster).toHaveBeenCalledWith("manager", "collaboration");
    expect(resolved).toContain("collab-specialist");
    expect(resolved).not.toContain("builder-specialist");
  });

  it("resolveSystemPromptForDescriptor resolves specialist prompts in collaboration space for collab workers", async () => {
    const { config } = await makeConfig();
    const manager = createManagerDescriptor(config, repoRoot, {
      sessionSurface: "collab",
      collab: { workspaceId: "workspace-1", channelId: "channel-1" },
    });
    const worker: AgentDescriptor = {
      ...createManagerDescriptor(config, repoRoot, { agentId: "worker", managerId: manager.agentId, profileId: "manager" }),
      role: "worker",
      specialistId: "collab-specialist",
    };
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile("manager")]]);
    const descriptors = new Map<string, AgentDescriptor>([
      [manager.agentId, manager],
      [worker.agentId, worker],
    ]);
    const promptRegistry = new FileBackedPromptRegistry({
      dataDir: config.paths.dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL,
    });
    const specialistRegistry = {
      ...specialistRegistryStub(),
      resolveRoster: vi.fn(async (_profileId: string, targetSpace?: string) =>
        targetSpace === "collaboration"
          ? [{ specialistId: "collab-specialist", promptBody: "Collaboration worker prompt" }]
          : [{ specialistId: "collab-specialist", promptBody: "Builder worker prompt" }],
      ),
    };

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
      getSessionsForProfile: () => [manager],
      loadSpecialistRegistryModule: async () => specialistRegistry,
      getIntegrationContext: () => undefined,
      logDebug: () => {},
    });

    await expect(service.resolveSystemPromptForDescriptor(worker)).resolves.toBe("Collaboration worker prompt");
    expect(specialistRegistry.resolveRoster).toHaveBeenCalledWith("manager", "collaboration");
  });

  it("does not append repository reference inventory to workers owned by collaboration managers", async () => {
    const { config } = await makeConfig();
    const workspace = await mkdtemp(join(tmpdir(), "forge-collab-worker-reference-"));
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    await mkdir(join(workspace, ".forge", "reference"), { recursive: true });
    await writeFile(join(workspace, ".forge", "reference", "private.md"), "Do not leak.", "utf8");

    const manager = createManagerDescriptor(config, workspace, {
      sessionSurface: "collab",
      collab: { workspaceId: "workspace-1", channelId: "channel-1" },
    });
    const worker: AgentDescriptor = {
      ...createManagerDescriptor(config, workspace, { agentId: "worker", managerId: manager.agentId, profileId: "manager" }),
      role: "worker",
      specialistId: "collab-specialist",
    };
    const specialistRegistry = {
      ...specialistRegistryStub(),
      resolveRoster: vi.fn(async () => [{ specialistId: "collab-specialist", promptBody: "Collaboration worker prompt" }]),
    };

    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      profiles: new Map([["manager", createProfile("manager")]]),
      promptRegistry: new FileBackedPromptRegistry({
        dataDir: config.paths.dataDir,
        repoDir: config.paths.rootDir,
        builtinArchetypesDir: BUILTIN_ARCHETYPES,
        builtinOperationalDir: BUILTIN_OPERATIONAL,
      }),
      skillMetadataService: {} as never,
      getAgentMemoryPath: () => "/tmp/memory.md",
      ensureAgentMemoryFile: async () => {},
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => "manager",
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [manager],
      loadSpecialistRegistryModule: async () => specialistRegistry,
      getIntegrationContext: () => undefined,
      logDebug: () => {},
    });

    const prompt = await service.resolveSystemPromptForDescriptor(worker);
    expect(prompt).toBe("Collaboration worker prompt");
    expect(prompt).not.toContain("Repository Reference Documents");
    expect(prompt).not.toContain("private.md");
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
    const collabReferenceDir = getSessionReferenceDir(dataDir, profileId, collabDescriptor.agentId);
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

  it("migrates legacy collab context reference docs to session-root reference docs on prompt access", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const collabDescriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "collab-legacy-reference",
      profileId,
      archetypeId: "collaboration-channel",
      sessionSurface: "collab",
      collab: {
        workspaceId: "workspace-1",
        channelId: "channel-1",
      },
    });
    const legacyReferenceDir = getSessionContextReferenceDir(dataDir, profileId, collabDescriptor.agentId);
    const rootReferenceDir = getSessionReferenceDir(dataDir, profileId, collabDescriptor.agentId);
    await writeReferenceDoc(legacyReferenceDir, "legacy-playbook.md", "Legacy escalation playbook.");

    const promptRegistry = new FileBackedPromptRegistry({
      dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });
    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[collabDescriptor.agentId, collabDescriptor]]),
      profiles: new Map([[profileId, createProfile(collabDescriptor.agentId)]]),
      promptRegistry,
      skillMetadataService: {} as never,
      getAgentMemoryPath: () => "/tmp/memory.md",
      ensureAgentMemoryFile: async () => {},
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => profileId,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [collabDescriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const resolved = await service.buildResolvedManagerPrompt(collabDescriptor);

    expect(resolved).toContain("# Channel Reference: legacy-playbook.md\n\nLegacy escalation playbook.");
    await expect(readFile(join(rootReferenceDir, "legacy-playbook.md"), "utf8")).resolves.toContain(
      "Legacy escalation playbook."
    );
  });

  it("uses session-root collab reference docs without falling back to legacy docs when root docs exist", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const collabDescriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "collab-root-reference",
      profileId,
      archetypeId: "collaboration-channel",
      sessionSurface: "collab",
      collab: {
        workspaceId: "workspace-1",
        channelId: "channel-1",
      },
    });
    await writeReferenceDoc(
      getSessionReferenceDir(dataDir, profileId, collabDescriptor.agentId),
      "root-playbook.md",
      "Root reference wins."
    );
    await writeReferenceDoc(
      getSessionContextReferenceDir(dataDir, profileId, collabDescriptor.agentId),
      "legacy-playbook.md",
      "Legacy reference should not be injected."
    );

    const promptRegistry = new FileBackedPromptRegistry({
      dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });
    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[collabDescriptor.agentId, collabDescriptor]]),
      profiles: new Map([[profileId, createProfile(collabDescriptor.agentId)]]),
      promptRegistry,
      skillMetadataService: {} as never,
      getAgentMemoryPath: () => "/tmp/memory.md",
      ensureAgentMemoryFile: async () => {},
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => profileId,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [collabDescriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const resolved = await service.buildResolvedManagerPrompt(collabDescriptor);

    expect(resolved).toContain("# Channel Reference: root-playbook.md\n\nRoot reference wins.");
    expect(resolved).not.toContain("Legacy reference should not be injected.");
  });

  it("project-agent with no custom prompt uses base prompt without requiring an archetype", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "agent-base-only",
      archetypeId: "missing-archetype",
      projectAgent: {
        handle: "base-only",
        whenToUse: "testing base-only prompt composition"
      }
    });
    const service = createPromptServiceForDescriptor(config, descriptor);

    const composition = await service.resolveProjectAgentPromptComposition(descriptor);
    expect(composition.rolePrompt).toBeUndefined();
    expect(composition.sources.map((source) => source.kind)).toEqual(["project_agent_base", "base_only"]);
    expect(composition.content).toContain("Forge Project Agent Operating Contract");
    expect(composition.content).toContain("Non-Negotiable Forge Routing Contract");

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).toContain("Forge Project Agent Operating Contract");
    expect(resolved).toContain("Direct end-user requests to this Project Agent session");

    const preview = await service.previewManagerSystemPromptForAgent(descriptor.agentId);
    const systemSection = preview.sections.find((section) => section.label === "System Prompt");
    expect(systemSection?.source).toBe("project-agent-base + base-only");
    expect(systemSection?.content).toContain("Forge Project Agent Operating Contract");
  });

  it("project-agent sessionSystemPrompt is composed as highest-precedence role instructions in preview", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "agent-session-prompt",
      sessionSystemPrompt: "Session role instructions win.",
      projectAgent: {
        handle: "session-prompt",
        whenToUse: "testing session prompt precedence",
        systemPrompt: "Descriptor fallback should lose."
      }
    });
    const service = createPromptServiceForDescriptor(config, descriptor);

    const composition = await service.resolveProjectAgentPromptComposition(descriptor);
    expect(composition.rolePrompt).toBe("Session role instructions win.");
    expect(composition.sources).toContainEqual({ kind: "session_system_prompt", agentId: descriptor.agentId });
    expect(composition.content).toContain("Forge Project Agent Operating Contract");
    expect(composition.content).toContain("Session role instructions win.");
    expect(composition.content).not.toContain("Descriptor fallback should lose.");

    const preview = await service.previewManagerSystemPromptForAgent(descriptor.agentId);
    const systemSection = preview.sections.find((section) => section.label === "System Prompt");
    expect(systemSection?.source).toBe("project-agent-base + sessionSystemPrompt:agent-session-prompt");
    expect(systemSection?.content).toContain("Session role instructions win.");
  });

  it("ignoreProjectAgentSystemPrompt returns base-only composition for project agents", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "agent-ignore-role",
      sessionSystemPrompt: "Session role should be ignored.",
      projectAgent: {
        handle: "ignore-role",
        whenToUse: "testing ignoreProjectAgentSystemPrompt",
        systemPrompt: "Descriptor role should be ignored."
      }
    });
    const service = createPromptServiceForDescriptor(config, descriptor);

    const resolved = await service.buildResolvedManagerPrompt(descriptor, { ignoreProjectAgentSystemPrompt: true });
    expect(resolved).toContain("Forge Project Agent Operating Contract");
    expect(resolved).not.toContain("Session role should be ignored.");
    expect(resolved).not.toContain("Descriptor role should be ignored.");
  });

  it("project-agent base prompt preserves model-specific placeholder injection", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "agent-model-instructions",
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.4",
        thinkingLevel: "medium"
      },
      projectAgent: {
        handle: "model-instructions",
        whenToUse: "testing model instructions"
      }
    });
    const service = createPromptServiceForDescriptor(config, descriptor);

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).toContain("# Model-Specific Instructions");
    expect(resolved).not.toContain("${MODEL_SPECIFIC_INSTRUCTIONS}");
  });

  it("buildResolvedManagerPrompt and prompt override ignore foreign project-agent handle records", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const sharedHandle = "shared-handle";
    await writeProjectAgentRecord(
      dataDir,
      profileId,
      {
        version: 1,
        agentId: "agent-b",
        handle: sharedHandle,
        whenToUse: "winner",
        promotedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      },
      "Winner on-disk prompt"
    );
    await writeProjectAgentReferenceDoc(dataDir, profileId, sharedHandle, "winner.md", "Winner reference");

    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "agent-a",
      projectAgent: {
        handle: sharedHandle,
        whenToUse: "loser",
        systemPrompt: "Loser descriptor prompt"
      }
    });
    const promptRegistry = new FileBackedPromptRegistry({
      dataDir: config.paths.dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });
    const sessionMemoryPath = resolveMemoryFilePath(dataDir, descriptor, undefined);
    await ensureMemoryFile(sessionMemoryPath, "# Session mem\n");
    await ensureMemoryFile(getProfileMemoryPath(dataDir, profileId), "# Profile mem\n");
    await ensureMemoryFile(getCommonKnowledgePath(dataDir), "");
    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      profiles: new Map([[profileId, createProfile(descriptor.agentId)]]),
      promptRegistry,
      skillMetadataService: {
        ensureSkillMetadataLoaded: async () => {},
        getSkillMetadata: () => [],
        getAdditionalSkillPaths: () => []
      } as never,
      getAgentMemoryPath: () => sessionMemoryPath,
      ensureAgentMemoryFile: async (path) => ensureMemoryFile(path, "# m\n"),
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => profileId,
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [descriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const override = await service.resolveProjectAgentSystemPromptOverride(descriptor);
    expect(override).toEqual({ prompt: "Loser descriptor prompt", sourcePath: undefined });

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).not.toContain("Winner reference");
    expect(resolved).not.toContain("Winner on-disk prompt");

    const preview = await service.previewManagerSystemPromptForAgent(descriptor.agentId);
    const systemSection = preview.sections.find((section) => section.label === "System Prompt");
    expect(systemSection).toBeDefined();
    expect(systemSection?.source).toBe(`project-agent-base + project-agent-descriptor:${sharedHandle}`);
    expect(typeof systemSection?.source).toBe("string");
    expect(systemSection?.content).toContain("Loser descriptor prompt");
    expect(systemSection?.content).not.toContain("Winner on-disk prompt");
  });

  it("resolves repo-sourced project-agent prompt and references without falling back to stale local prompt bodies", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const handle = "repo-docs";
    const workspace = join(dataDir, "workspace");
    await mkdir(workspace, { recursive: true });
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const forgeDir = join(workspace, ".forge");
    const definitionDir = join(forgeDir, "project-agents", handle);
    await mkdir(join(definitionDir, "reference"), { recursive: true });
    await writeFile(join(definitionDir, "config.json"), JSON.stringify({
      version: 1,
      handle,
      whenToUse: "Repo docs guidance"
    }));
    await writeFile(join(definitionDir, "prompt.md"), "Repo prompt body");
    await writeFile(join(definitionDir, "reference", "repo.md"), "Repo reference body");
    await writeProjectAgentRecord(
      dataDir,
      profileId,
      {
        version: 1,
        agentId: "agent-1",
        handle,
        whenToUse: "Stale local guidance",
        promotedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z"
      },
      "Stale local prompt"
    );
    await writeProjectAgentReferenceDoc(dataDir, profileId, handle, "stale.md", "Stale local reference");

    const workspaceRealpath = await realpath(workspace);
    const descriptor = createManagerDescriptor(config, workspace, {
      agentId: "agent-1",
      projectAgent: {
        handle,
        whenToUse: "Repo guidance mirror",
        systemPrompt: "Stale descriptor prompt",
        source: {
          type: "repo",
          workspaceKey: `${profileId}::${workspaceRealpath}`,
          forgeDirRealpath: await realpath(forgeDir),
          definitionId: handle,
          activatedAt: "2026-04-03T00:00:00.000Z"
        }
      }
    });
    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      profiles: new Map([[profileId, createProfile(descriptor.agentId)]]),
      promptRegistry: new FileBackedPromptRegistry({
        dataDir,
        repoDir: config.paths.rootDir,
        builtinArchetypesDir: BUILTIN_ARCHETYPES,
        builtinOperationalDir: BUILTIN_OPERATIONAL
      }),
      skillMetadataService: { getEnabledSkillsForAgent: async () => [] } as never,
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

    await expect(service.resolveProjectAgentSystemPromptOverride(descriptor)).resolves.toEqual({
      prompt: "Repo prompt body",
      sourcePath: join(await realpath(definitionDir), "prompt.md")
    });
    const composition = await service.resolveProjectAgentPromptComposition(descriptor);
    expect(composition.content).toContain("Forge Project Agent Operating Contract");
    expect(composition.content).toContain("Repo prompt body");
    expect(composition.content).toContain("Non-Negotiable Forge Routing Contract");
    expect(composition.sources).toContainEqual({
      kind: "repo_prompt",
      sourcePath: join(await realpath(definitionDir), "prompt.md"),
      definitionId: handle,
    });

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).toContain("Repo prompt body");
    expect(resolved).toContain("Repo reference body");
    expect(resolved).not.toContain("Stale local prompt");
    expect(resolved).not.toContain("Stale local reference");
  });

  it("reports missing repo-sourced project-agent definitions without falling back to archetype/default prompts", async () => {
    const { config } = await makeConfig();
    const forgeDir = join(config.paths.dataDir, "repo-forge");
    await mkdir(forgeDir, { recursive: true });
    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "agent-1",
      projectAgent: {
        handle: "missing-docs",
        whenToUse: "Repo guidance mirror",
        systemPrompt: "Stale descriptor prompt",
        source: {
          type: "repo",
          workspaceKey: "workspace-a",
          forgeDirRealpath: await realpath(forgeDir),
          definitionId: "missing-docs",
          activatedAt: "2026-04-03T00:00:00.000Z"
        }
      }
    });
    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      profiles: new Map([["manager", createProfile(descriptor.agentId)]]),
      promptRegistry: new FileBackedPromptRegistry({
        dataDir: config.paths.dataDir,
        repoDir: config.paths.rootDir,
        builtinArchetypesDir: BUILTIN_ARCHETYPES,
        builtinOperationalDir: BUILTIN_OPERATIONAL
      }),
      skillMetadataService: { getEnabledSkillsForAgent: async () => [] } as never,
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

    await expect(service.previewManagerSystemPromptForAgent(descriptor.agentId)).rejects.toThrow(/repo_project_agents_missing|missing/i);
    await expect(service.buildResolvedManagerPrompt(descriptor)).rejects.toThrow(/repo_project_agents_missing|missing/i);
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
      agentId: "agent-1",
      projectAgent: {
        handle,
        whenToUse: "test"
      }
    });

    const service = new SwarmPromptService({
      config,
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      profiles: new Map([[profileId, createProfile(descriptor.agentId)]]),
      promptRegistry: createPromptRegistry(config),
      skillMetadataService: {
        ensureSkillMetadataLoaded: async () => {},
        getSkillMetadata: () => [],
        getAdditionalSkillPaths: () => []
      } as never,
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

    const composition = await service.resolveProjectAgentPromptComposition(descriptor);
    expect(composition.content).toContain("Forge Project Agent Operating Contract");
    expect(composition.content).toContain("On-disk override body for tests.");
    expect(composition.content).toContain("Non-Negotiable Forge Routing Contract");
    expect(composition.sources).toContainEqual({
      kind: "profile_prompt",
      sourcePath: resolved.sourcePath,
      handle,
    });
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

  it("uses descriptor-aware skills for preview, memory resources, Claude, and ACP prompts", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const descriptor = createManagerDescriptor(config, repoRoot, { sessionSurface: "collab" });
    const profiles = new Map<string, ManagerProfile>([["manager", createProfile("manager")]]);
    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const promptRegistry = new FileBackedPromptRegistry({
      dataDir,
      repoDir: config.paths.rootDir,
      builtinArchetypesDir: BUILTIN_ARCHETYPES,
      builtinOperationalDir: BUILTIN_OPERATIONAL
    });
    await ensureMemoryFile(resolveMemoryFilePath(dataDir, descriptor, undefined), "# Session mem\n");
    await ensureMemoryFile(getProfileMemoryPath(dataDir, "manager"), "# Profile mem\n");
    await ensureMemoryFile(getCommonKnowledgePath(dataDir), "");

    const memorySkill = fakeSkillMetadata("memory");
    const selectedSkill = fakeSkillMetadata("brave-search");
    const unselectedSkill = fakeSkillMetadata("agent-browser");
    const service = new SwarmPromptService({
      config,
      descriptors,
      profiles,
      promptRegistry,
      skillMetadataService: {
        ensureSkillMetadataLoaded: async () => {},
        getSkillMetadata: () => [memorySkill, selectedSkill, unselectedSkill],
        getAdditionalSkillPaths: () => [memorySkill.path, selectedSkill.path, unselectedSkill.path]
      } as never,
      resolveSkillRosterForDescriptor: async () => [memorySkill, selectedSkill],
      getAgentMemoryPath: () => resolveMemoryFilePath(dataDir, descriptor, undefined),
      ensureAgentMemoryFile: async (path) => ensureMemoryFile(path, "# m\n"),
      resolveMemoryOwnerAgentId: (d) => d.agentId,
      resolveSessionProfileId: () => "manager",
      refreshSessionMetaStats: async () => {},
      refreshSessionMetaStatsBySessionId: async () => {},
      getSessionsForProfile: () => [descriptor],
      loadSpecialistRegistryModule: async () => specialistRegistryStub(),
      getIntegrationContext: () => undefined,
      logDebug: () => {}
    });

    const preview = await service.previewManagerSystemPromptForAgent(descriptor.agentId);
    const systemSection = preview.sections.find((section) => section.label === "System Prompt")?.content ?? "";
    expect(systemSection).toContain("<name>memory</name>");
    expect(systemSection).toContain("<name>brave-search</name>");
    expect(systemSection).not.toContain("agent-browser");

    const resources = await service.getMemoryRuntimeResources(descriptor);
    expect(resources.additionalSkillPaths).toEqual([memorySkill.path, selectedSkill.path]);
    expect(resources.skillMetadata.map((skill) => skill.directoryName)).toEqual(["memory", "brave-search"]);

    const claudePrompt = await service.buildClaudeRuntimeSystemPrompt(descriptor, "Base prompt");
    expect(claudePrompt).toContain("<name>memory</name>");
    expect(claudePrompt).toContain("<name>brave-search</name>");
    expect(claudePrompt).not.toContain("agent-browser");

    const acpPrompt = await service.buildAcpRuntimeSystemPrompt(descriptor, "Base prompt");
    expect(acpPrompt).toContain("<name>memory</name>");
    expect(acpPrompt).toContain("<name>brave-search</name>");
    expect(acpPrompt).not.toContain("agent-browser");
    expect(acpPrompt).toContain("## ACP Runtime");
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
