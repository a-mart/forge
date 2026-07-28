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
import { estimateTokens } from "../knowledge-service.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";
import {
  getCommonKnowledgePath,
  getKnowledgeIndexPath,
  getProfileKnowledgeIndexPath,
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

function expectCurrentProjectAgentRoutingFooter(prompt: string): void {
  expect(prompt).toContain("Worker results require disposition but are not automatic user or peer updates");
  expect(prompt).toContain("Direct request or accepted closeout: normal final text");
  expect(prompt).toContain("Routed or proactive publication: `speak_to_user`, then exactly `NO_REPLY`");
  expect(prompt).toContain("Peer context: honor the sender's stated response expectation");
  expect(prompt).toContain("Never send courtesy-only acknowledgments or closure replies");
  expect(prompt).toContain("Never duplicate a reply through two paths");
  expect(prompt).not.toContain("use `speak_to_user` for user-facing closeouts");
  expect(prompt).not.toContain("an accepted outcome/material blocker reached from an internal callback");
}

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
    resolveTierConfigs: vi.fn(async () => []),
    generateRosterBlock: vi.fn(() => "Specialist roster for tests."),
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

function createPromptServiceForDescriptor(
  config: SwarmConfig,
  descriptor: AgentDescriptor,
  options?: {
    getKnowledgeV2Enabled?: () => boolean;
    specialistRoster?: Array<{ specialistId: string; promptBody: string }>;
    specialistRegistryError?: Error;
    logDebug?: (message: string, details?: unknown) => void;
  },
): SwarmPromptService {
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
    ensureAgentMemoryFile: async (path) => {
      try {
        await readFile(path, "utf8");
      } catch {
        await ensureMemoryFile(path, "# m\n");
      }
    },
    resolveMemoryOwnerAgentId: (d) => d.agentId,
    resolveSessionProfileId: () => profileId,
    refreshSessionMetaStats: async () => {},
    refreshSessionMetaStatsBySessionId: async () => {},
    getSessionsForProfile: () => [descriptor],
    loadSpecialistRegistryModule: async () => {
      if (options?.specialistRegistryError) {
        throw options.specialistRegistryError;
      }
      return {
        ...specialistRegistryStub(),
        resolveRoster: vi.fn(async () => options?.specialistRoster ?? []),
      };
    },
    getKnowledgeV2Enabled: options?.getKnowledgeV2Enabled,
    logDebug: options?.logDebug ?? (() => {})
  });
}

describe("SwarmPromptService", () => {
  it("appends current manager routing contract after copied stale session prompts", async () => {
    const { config } = await makeConfig();
    const staleSessionPrompt = `You are the manager agent in a multi-agent swarm.

# User-facing output
User-facing output is allowed only through:
- \`speak_to_user\` for normal messages
- \`present_choices\` for structured choice UI on channels that support it

Never use plain assistant text for user communication.`;
    const descriptor = createManagerDescriptor(config, config.paths.defaultCwd, {
      sessionSystemPrompt: staleSessionPrompt,
    });
    const service = createPromptServiceForDescriptor(config, descriptor);

    const prompt = await service.buildResolvedManagerPrompt(descriptor);

    expect(prompt).toContain("Never use plain assistant text for user communication.");
    expect(prompt).toContain("# User-Facing Visualizations");
    expect(prompt).toContain("roughly 5-12 important nodes");
    expect(prompt.indexOf("Never use plain assistant text for user communication.")).toBeLessThan(
      prompt.indexOf("# User-Facing Visualizations")
    );
    expect(prompt).toContain("# Non-Negotiable Forge Routing Contract");
    expect(prompt).toContain(
      "Direct request or accepted closeout: normal final text"
    );
    expect(prompt).toContain(
      "Routed or proactive publication: `speak_to_user`, then exactly `NO_REPLY`"
    );
    expect(prompt).not.toMatch(/Telegram|channelId|threadTs|explicit-target/i);
    expect(prompt).toContain("use `NO_REPLY` to skip an unanswered direct request");
    expect(prompt).not.toContain("other routed user-facing delivery");
    expect(prompt.lastIndexOf("# Non-Negotiable Forge Routing Contract")).toBeGreaterThan(
      prompt.indexOf("Never use plain assistant text for user communication.")
    );
  });

  it("preserves custom old-marker repo manager overrides while appending the current routing contract", async () => {
    const customRepoRoot = await mkdtemp(join(tmpdir(), "custom-old-manager-prompt-repo-"));
    const repoArchetypeDir = join(customRepoRoot, ".swarm", "archetypes");
    await mkdir(repoArchetypeDir, { recursive: true });
    await writeFile(
      join(repoArchetypeDir, "manager.md"),
      `You are the manager agent in a multi-agent swarm.

# User-facing output
User-facing output is allowed only through:
- \`speak_to_user\` for normal messages
- \`present_choices\` for structured choice UI on channels that support it

Never use plain assistant text for user communication.

Custom project instruction: always mention the release train when summarizing deploy work.`,
      "utf8",
    );

    const handle = await createTempConfig({
      prefix: "swarm-prompt-service-custom-old-manager-",
      port: 0,
      rootDir: customRepoRoot,
      resourcesDir: repoRoot,
      defaultCwd: customRepoRoot,
      cwdAllowlistRoots: [customRepoRoot],
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

    const descriptor = createManagerDescriptor(handle.config, customRepoRoot);
    const service = createPromptServiceForDescriptor(handle.config, descriptor);

    const prompt = await service.buildResolvedManagerPrompt(descriptor);

    expect(prompt).toContain("Custom project instruction: always mention the release train");
    expect(prompt).toContain("Never use plain assistant text for user communication.");
    expect(prompt).toContain("# Non-Negotiable Forge Routing Contract");
    expect(prompt).toContain(
      "Direct request or accepted closeout: normal final text"
    );
    expect(prompt).toContain(
      "Routed or proactive publication: `speak_to_user`, then exactly `NO_REPLY`"
    );
    expect(prompt).not.toMatch(/Telegram|channelId|threadTs|explicit-target/i);
    expect(prompt).toContain("use `NO_REPLY` to skip an unanswered direct request");
    expect(prompt).not.toContain("other routed user-facing delivery");
    expect(prompt.lastIndexOf("# Non-Negotiable Forge Routing Contract")).toBeGreaterThan(
      prompt.indexOf("Never use plain assistant text for user communication.")
    );
  });

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

  it("includes concise working-plan and goal guidance in the resolved manager prompt", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot);
    const service = createPromptServiceForDescriptor(config, descriptor);

    const resolved = await service.buildResolvedManagerPrompt(descriptor);

    expect(resolved).toContain("Keep one active coordination lane for the current phase")
    expect(resolved).toContain("**Checklist:** use `update_plan`")
    expect(resolved).toContain("**Graph:** use `update_work_graph`")
    expect(resolved).toContain("call `accept_work_graph_node` with concise evidence")
    expect(resolved).toContain("all three conditions hold")
    expect(resolved).toContain("choose Graph only when scheduler-owned release or retry materially helps")
    expect(resolved).toContain("smallest DAG that exposes useful concurrency")
    expect(resolved).toContain("each dispatched node has one worker owner at a time")
    expect(resolved).toContain("Task size, step count, thoroughness, planning, review")
    expect(resolved).toContain("one bounded planning or discovery investigation")
    expect(resolved).toContain("never owns scheduler state or graph mutation")
    expect(resolved).toContain("Do not impose a mandatory planner, implementer, reviewer, or synthesis chain")
    expect(resolved).toContain("Graph size and fan-in do not justify a stronger executor")
    expect(resolved).toContain("pass its stable `id` as `planStepId`")
    expect(resolved).toContain("Creating or updating a plan is coordination, not execution")
    expect(resolved).toContain("Use `create_goal` only when the user explicitly asks")
    expect(resolved).toContain("a goal may span multiple plans")
    expect(resolved).toContain("same blocker persists for at least three goal turns")
    expect(resolved).toContain("A goal never expands authority")
  });

  it("composes exactly one concise manager posture block", async () => {
    const { config } = await makeConfig();
    const delegationFirst = createManagerDescriptor(config, repoRoot);
    const handsOn = createManagerDescriptor(config, repoRoot, {
      managerPosture: "hands_on",
    });
    const delegationPrompt = await createPromptServiceForDescriptor(
      config,
      delegationFirst,
    ).buildResolvedManagerPrompt(delegationFirst);
    const handsOnPrompt = await createPromptServiceForDescriptor(
      config,
      handsOn,
    ).buildResolvedManagerPrompt(handsOn);

    expect(delegationPrompt).toContain("Your posture is **Delegation-first**.")
    expect(delegationPrompt).toContain("Manager direct project work is read-only.")
    expect(delegationPrompt).toContain(
      "Follow the active Work routing posture when deciding whether you or a worker owns implementation and investigation.",
    );
    expect(delegationPrompt).toContain("# Delegation protocol")
    expect(delegationPrompt).toContain("## Working plans")
    expect(handsOnPrompt).toContain("Your posture is **Hands-on**.")
    expect(handsOnPrompt).toContain("Normally own one cohesive outcome directly")
    expect(handsOnPrompt).toContain("This posture changes preference, not authority")
    expect(handsOnPrompt).toContain("## Optional coordination")
    expect(handsOnPrompt).toContain("One bounded worker remains Direct")
    expect(handsOnPrompt).not.toContain("# Delegation protocol")
    expect(handsOnPrompt).not.toContain("## Working plans")
    expect(handsOnPrompt).not.toContain("Delegate workers with a behavior")
    expect(handsOnPrompt).not.toContain(
      "Workers should own substantial implementation and investigation",
    );
    expect(delegationPrompt.match(/^# Work routing$/gm)).toHaveLength(1)
    expect(handsOnPrompt.match(/^# Work routing$/gm)).toHaveLength(1)
    expect(delegationPrompt).not.toContain("$" + "{MANAGER_POSTURE}")
    expect(handsOnPrompt).not.toContain("$" + "{MANAGER_POSTURE}")
    expect(delegationPrompt).not.toContain("forge:manager-coordination")
    expect(handsOnPrompt).not.toContain("forge:manager-coordination")
    expect(delegationPrompt.length - handsOnPrompt.length).toBeGreaterThan(2_000)
  });

  it("replaces the legacy routing section in stale manager prompt overrides", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      managerPosture: "hands_on",
      sessionSystemPrompt: `You are a customized manager.

# Work routing
For each substantive request, choose one route.

Delegation remains the default for project-file mutations, sustained investigations, multi-step analysis, and substantial implementation. Manager direct project work is read-only.

# Custom project policy
Always preserve the user's release notes.`,
    });
    const prompt = await createPromptServiceForDescriptor(
      config,
      descriptor,
    ).buildResolvedManagerPrompt(descriptor);

    expect(prompt.match(/^# Work routing$/gm)).toHaveLength(1);
    expect(prompt).toContain("Your posture is **Hands-on**.");
    expect(prompt).not.toContain("Manager direct project work is read-only.");
    expect(prompt).not.toContain("Delegation remains the default for project-file mutations");
    expect(prompt).toContain("# Custom project policy");
    expect(prompt).toContain("Always preserve the user's release notes.");
  });

  it("keeps tool authority aligned with the selected manager posture", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot);
    const service = createPromptServiceForDescriptor(config, descriptor);
    const handsOnDescriptor = createManagerDescriptor(config, repoRoot, {
      managerPosture: "hands_on",
    });
    const handsOnService = createPromptServiceForDescriptor(config, handsOnDescriptor);

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    const handsOn = await handsOnService.buildResolvedManagerPrompt(handsOnDescriptor);

    expect(resolved).toContain("bounded read-only orientation");
    expect(resolved).toContain("If a direct lookup exposes material implementation or investigation");
    expect(resolved).toContain("Manager direct project work is read-only");
    expect(resolved).toContain("In Delegation-first, direct project work is read-only");
    expect(handsOn).toContain("In Hands-on, you may use normal project tools");
    expect(handsOn).toContain("one bounded manager-owned outcome");
    expect(handsOn).not.toContain("Do not use `edit`/`write` for project work");
  });

  it("requires an Other choice unless the user explicitly intends a closed confirmation", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot);
    const service = createPromptServiceForDescriptor(config, descriptor);

    const resolved = await service.buildResolvedManagerPrompt(descriptor);

    expect(resolved).toContain(
      'Always include an "Other / Custom" response option so the user can provide an answer outside the listed choices.'
    );
    expect(resolved).toContain(
      "Omit it only for a deliberately closed confirmation when the user's request clearly makes that constraint intentional."
    );
    expect(resolved).not.toContain('when reasonable answers may fall outside the listed choices');
  });

  it("buildResolvedManagerPrompt removes the model-specific placeholder when no user instructions exist", async () => {
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
      logDebug: () => {}
    });

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).not.toContain("# Model-Specific Instructions");
    expect(resolved).not.toContain("$" + "{MODEL_SPECIFIC_INSTRUCTIONS}");
    expect(resolved).toContain("Specialist roster for tests.");
    expect(resolved).not.toContain("Legacy routing guidance for tests.");
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
      logDebug: () => {},
    });

    await expect(service.resolveSystemPromptForDescriptor(worker)).resolves.toBe("Collaboration worker prompt");
    expect(specialistRegistry.resolveRoster).toHaveBeenCalledWith("manager", "collaboration");
  });

  it.each([
    ["architect", "architecture role"],
    ["planner", "planning role"],
    ["code-reviewer", "correctness role"],
    ["code-reviewer-2", "design role"],
    ["researcher", "research role"],
  ])("layers the stable worker contract into the final %s mode prompt", async (specialistId, rolePrompt) => {
    const { config } = await makeConfig();
    const worker = {
      ...createManagerDescriptor(config, repoRoot, {
        agentId: `${specialistId}-worker`,
        managerId: "manager",
        profileId: "manager",
      }),
      role: "worker" as const,
      specialistLens: specialistId,
    } as AgentDescriptor;
    const service = createPromptServiceForDescriptor(config, worker, {
      specialistRoster: [{ specialistId, promptBody: rolePrompt }],
    });

    const prompt = await service.resolveSystemPromptForDescriptor(worker);

    expect(prompt).toContain("# Forge Worker Contract");
    expect(prompt).toContain("Messages prefixed with `SYSTEM:` are internal control");
    expect(prompt).toContain("Write memory only when explicitly asked");
    expect(prompt).toContain("Escalate before destructive actions");
    expect(prompt).toContain("# Behavior Instructions");
    expect(prompt).toContain(rolePrompt);
  });

  it("fails closed when a required behavior-mode prompt cannot be resolved", async () => {
    const { config } = await makeConfig();
    const worker = {
      ...createManagerDescriptor(config, repoRoot, {
        agentId: "review-worker",
        managerId: "manager",
        profileId: "manager",
        archetypeId: undefined,
      }),
      role: "worker" as const,
      specialistTier: "deep" as const,
      specialistLens: "code-reviewer",
      specialistId: "deep:code-reviewer",
    } as AgentDescriptor;
    const logDebug = vi.fn();
    const service = createPromptServiceForDescriptor(config, worker, {
      specialistRegistryError: new Error("temporary roster read failure"),
      logDebug,
    });

    await expect(service.resolveSystemPromptForDescriptor(worker)).rejects.toThrow(
      'Required worker behavior prompt "code-reviewer" could not be resolved: temporary roster read failure',
    );
    expect(logDebug).toHaveBeenCalledWith(
      "specialist:resolve:error",
      expect.objectContaining({ specialistId: "code-reviewer" }),
    );
  });

  it("fails closed when a required behavior-mode prompt is missing", async () => {
    const { config } = await makeConfig();
    const worker = {
      ...createManagerDescriptor(config, repoRoot, {
        agentId: "plan-worker",
        managerId: "manager",
        profileId: "manager",
        archetypeId: undefined,
      }),
      role: "worker" as const,
      specialistTier: "deep" as const,
      specialistLens: "planner",
      specialistId: "deep:planner",
    } as AgentDescriptor;
    const service = createPromptServiceForDescriptor(config, worker);

    await expect(service.resolveSystemPromptForDescriptor(worker)).rejects.toThrow(
      'Required worker behavior prompt "planner" is missing or empty.',
    );
  });

  it("does not resolve a tier attribution id as a custom specialist prompt", async () => {
    const { config } = await makeConfig();
    const worker = {
      ...createManagerDescriptor(config, repoRoot, {
        agentId: "routine-worker",
        managerId: "manager",
        profileId: "manager",
        archetypeId: undefined,
      }),
      role: "worker" as const,
      specialistTier: "standard" as const,
      specialistId: "standard",
    } as AgentDescriptor;
    const service = createPromptServiceForDescriptor(config, worker, {
      specialistRoster: [{ specialistId: "standard", promptBody: "Custom standard specialist prompt" }],
    });

    const prompt = await service.resolveSystemPromptForDescriptor(worker);

    expect(prompt).toContain("End your turn with a concise result using this structure:");
    expect(prompt).not.toContain("Custom standard specialist prompt");
  });

  it("does not resolve a route attribution id as a custom specialist prompt", async () => {
    const { config } = await makeConfig();
    const worker = {
      ...createManagerDescriptor(config, repoRoot, {
        agentId: "route-worker",
        managerId: "manager",
        profileId: "manager",
        archetypeId: undefined,
      }),
      role: "worker" as const,
      delegationRouteId: "research-analyst",
      specialistId: "route:research-analyst",
    } as AgentDescriptor;
    const service = createPromptServiceForDescriptor(config, worker, {
      specialistRoster: [{
        specialistId: "research-analyst",
        promptBody: "This route id must not become a behavior prompt.",
      }],
    });

    const prompt = await service.resolveSystemPromptForDescriptor(worker);

    expect(prompt).toContain("End your turn with a concise result using this structure:");
    expect(prompt).not.toContain("This route id must not become a behavior prompt.");
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
      logDebug: () => {},
    });

    const prompt = await service.resolveSystemPromptForDescriptor(worker);
    expect(prompt).toBe("Collaboration worker prompt");
    expect(prompt).not.toContain("Repository Reference Documents");
    expect(prompt).not.toContain("private.md");
  });

  it("gives a lens-less worker the automatic structured-result contract", async () => {
    const { config } = await makeConfig();
    const worker = {
      ...createManagerDescriptor(config, repoRoot, {
        agentId: "light-worker",
        managerId: "manager",
        profileId: "manager",
        sessionSurface: "collab",
        collab: { workspaceId: "workspace-1", channelId: "channel-1" },
      }),
      role: "worker" as const,
      archetypeId: "worker",
    } as AgentDescriptor;

    const service = createPromptServiceForDescriptor(config, worker);
    const prompt = await service.resolveSystemPromptForDescriptor(worker);

    expect(prompt).toContain(
      "Your final assistant response is returned to the manager automatically. Do not call a messaging tool to report completion."
    );
    expect(prompt).toContain("End your turn with a concise result using this structure:");
    expect(prompt).toContain("status: done | partial | blocked");
  });

  it("keeps built-in source and resolved prompts aligned with the web-only speak_to_user schema", async () => {
    const { config } = await makeConfig();
    const invalidSpeakTargetGuidance = /Telegram|non-web|channelId|threadTs|proactive external|explicit-target|target metadata/i;
    const archetypes = ["manager", "collaboration-channel", "agent-architect"] as const;

    for (const archetypeId of archetypes) {
      const source = await readFile(join(BUILTIN_ARCHETYPES, `${archetypeId}.md`), "utf8");
      expect(source, `${archetypeId} source prompt`).not.toMatch(invalidSpeakTargetGuidance);

      const descriptor = createManagerDescriptor(config, repoRoot, {
        agentId: `${archetypeId}-prompt-agent`,
        archetypeId,
        ...(archetypeId === "collaboration-channel"
          ? {
              sessionSurface: "collab" as const,
              collab: { workspaceId: "workspace-1", channelId: "channel-1" },
            }
          : {}),
      });
      const resolved = await createPromptServiceForDescriptor(config, descriptor)
        .resolveSystemPromptForDescriptor(descriptor);
      const resolvedSpeakGuidance = resolved
        .split("\n")
        .filter((line) => line.includes("speak_to_user"))
        .join("\n");
      expect(resolvedSpeakGuidance, `${archetypeId} resolved prompt`).not.toMatch(invalidSpeakTargetGuidance);
    }

    const manager = createManagerDescriptor(config, repoRoot, { archetypeId: "manager" });
    const managerPrompt = await createPromptServiceForDescriptor(config, manager)
      .resolveSystemPromptForDescriptor(manager);
    expect(managerPrompt).toContain("When a peer response is warranted, use `send_message_to_agent` to the source `fromAgentId`");
    expect(managerPrompt).toContain("If the message says no reply is needed (an information or ownership handoff), stay silent");
    expect(managerPrompt).toContain("Never send courtesy-only acknowledgments");
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
        resolveTierConfigs: async () => [],
        generateRosterBlock: () => "Specialist roster block",
      }),
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
    expect(composition.content).toContain("No reply needed (an information or ownership handoff): stay silent");
    expect(composition.content).toContain("A specific result requested: send that one terminal result when accepted");
    expect(composition.content).toContain("Coordination invited: necessary back-and-forth is allowed");
    expect(composition.content).toContain("messages beginning with `[workerResult]`");
    expect(composition.content).not.toContain("Non-Negotiable Forge Routing Contract");

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).toContain("Forge Project Agent Operating Contract");
    expect(resolved).toContain("# User-Facing Visualizations");
    expect(resolved.indexOf("# User-Facing Visualizations")).toBeLessThan(
      resolved.indexOf("# Non-Negotiable Forge Routing Contract")
    );
    expect(resolved).toContain("Direct web request or accepted closeout");
    expectCurrentProjectAgentRoutingFooter(resolved);
    expect(resolved.trimEnd()).toMatch(/Never duplicate a reply through two paths or use `NO_REPLY` to skip an unanswered direct request\.$/);

    const preview = await service.previewManagerSystemPromptForAgent(descriptor.agentId);
    const systemSection = preview.sections.find((section) => section.label === "System Prompt");
    expect(systemSection?.source).toBe("project-agent-base + base-only");
    expect(systemSection?.content).toContain("Forge Project Agent Operating Contract");
  });

  it("gives a Hands-on Project Agent one non-contradictory routing posture", async () => {
    const { config } = await makeConfig();
    const descriptor = createManagerDescriptor(config, repoRoot, {
      agentId: "hands-on-project-agent",
      managerPosture: "hands_on",
      projectAgent: {
        handle: "hands-on-agent",
        whenToUse: "testing project-agent posture composition",
        capabilities: ["create_session"],
      },
    });

    const resolved = await createPromptServiceForDescriptor(
      config,
      descriptor,
    ).buildResolvedManagerPrompt(descriptor);

    expect(resolved.match(/^# Work routing$/gm)).toHaveLength(1);
    expect(resolved).toContain("Your posture is **Hands-on**.");
    expect(resolved).toContain("Normally own one cohesive outcome directly");
    expect(resolved).not.toContain(
      "Delegate substantive implementation and investigation to appropriate workers",
    );
    expect(resolved).not.toContain("Manager direct project work is read-only.");
    expect(resolved).not.toContain("Delegate workers with a behavior");
    expect(resolved).not.toContain("## Working plans");
    expect(resolved).toContain(
      "This project agent can create new manager sessions via create_session.",
    );
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

  it("project-agent base prompt removes the model-specific placeholder when no user instructions exist", async () => {
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
    expect(resolved).not.toContain("# Model-Specific Instructions");
    expect(resolved).not.toContain("$" + "{MODEL_SPECIFIC_INSTRUCTIONS}");
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
      logDebug: () => {}
    });

    await expect(service.resolveProjectAgentSystemPromptOverride(descriptor)).resolves.toEqual({
      prompt: "Repo prompt body",
      sourcePath: join(await realpath(definitionDir), "prompt.md")
    });
    const composition = await service.resolveProjectAgentPromptComposition(descriptor);
    expect(composition.content).toContain("Forge Project Agent Operating Contract");
    expect(composition.content).toContain("Repo prompt body");
    expect(composition.content).not.toContain("Non-Negotiable Forge Routing Contract");
    expect(composition.sources).toContainEqual({
      kind: "repo_prompt",
      sourcePath: join(await realpath(definitionDir), "prompt.md"),
      definitionId: handle,
    });

    const resolved = await service.buildResolvedManagerPrompt(descriptor);
    expect(resolved).toContain("Repo prompt body");
    expect(resolved).toContain("Repo reference body");
    expect(resolved.indexOf("Repo reference body")).toBeLessThan(resolved.indexOf("# Non-Negotiable Forge Routing Contract"));
    expectCurrentProjectAgentRoutingFooter(resolved);
    expect(resolved.trimEnd()).toMatch(/Never duplicate a reply through two paths or use `NO_REPLY` to skip an unanswered direct request\.$/);
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
    await writeProjectAgentReferenceDoc(dataDir, profileId, handle, "local-ref.md", "Local reference body");

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
      logDebug: () => {}
    });

    const resolved = await service.resolveProjectAgentSystemPromptOverride(descriptor);
    expect(resolved.prompt).toBe("On-disk override body for tests.");
    expect(resolved.sourcePath).toMatch(/prompt\.md$/);

    const composition = await service.resolveProjectAgentPromptComposition(descriptor);
    expect(composition.content).toContain("Forge Project Agent Operating Contract");
    expect(composition.content).toContain("On-disk override body for tests.");
    expect(composition.content).not.toContain("Non-Negotiable Forge Routing Contract");
    expect(composition.sources).toContainEqual({
      kind: "profile_prompt",
      sourcePath: resolved.sourcePath,
      handle,
    });

    const finalPrompt = await service.buildResolvedManagerPrompt(descriptor);
    expect(finalPrompt).toContain("Local reference body");
    expect(finalPrompt.indexOf("Local reference body")).toBeLessThan(finalPrompt.indexOf("# Non-Negotiable Forge Routing Contract"));
    expectCurrentProjectAgentRoutingFooter(finalPrompt);
    expect(finalPrompt.trimEnd()).toMatch(/Never duplicate a reply through two paths or use `NO_REPLY` to skip an unanswered direct request\.$/);
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
      logDebug: () => {}
    });

    const files = await service.getSwarmContextFiles(level2);
    expect(files.map((f) => f.content.trim())).toEqual(["root", "level1"]);
  });

  it("uses descriptor-aware skills for preview, memory resources, Claude, and Cursor SDK prompts", async () => {
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

    const cursorSdkPrompt = await service.buildCursorSdkRuntimeSystemPrompt(descriptor, "Base prompt");
    expect(cursorSdkPrompt).toContain("<name>memory</name>");
    expect(cursorSdkPrompt).toContain("<name>brave-search</name>");
    expect(cursorSdkPrompt).not.toContain("agent-browser");
    expect(cursorSdkPrompt).toContain("## Cursor SDK Runtime");
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

  it("getMemoryRuntimeResources injects only generated knowledge indexes when knowledge v2 is enabled", async () => {
    const { config } = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const descriptor = createManagerDescriptor(config, repoRoot, { archetypeId: "cortex" });
    const sessionPath = resolveMemoryFilePath(
      dataDir,
      { agentId: "manager", role: "manager", profileId, managerId: "manager" },
      undefined,
    );
    const profilePath = getProfileMemoryPath(dataDir, profileId);
    const profileIndexPath = getProfileKnowledgeIndexPath(dataDir, profileId);
    const globalIndexPath = getKnowledgeIndexPath(dataDir);
    const commonPath = getCommonKnowledgePath(dataDir);

    await ensureMemoryFile(sessionPath, "## Session line\n");
    await ensureMemoryFile(
      profilePath,
      `## Legacy profile line\n${Array.from({ length: 80 }, (_, index) => `legacy-profile-${index}`).join(" ")}\n`,
    );
    await ensureMemoryFile(profileIndexPath, "# Knowledge Index (profile:manager)\n\n- [pref-a] Profile index line\n");
    await ensureMemoryFile(globalIndexPath, "# Knowledge Index (global)\n\n- [conv-a] Global index line\n");
    await ensureMemoryFile(
      commonPath,
      `Legacy common fact\n${Array.from({ length: 80 }, (_, index) => `legacy-common-${index}`).join(" ")}\n`,
    );

    let knowledgeV2Enabled = true;
    const service = createPromptServiceForDescriptor(config, descriptor, {
      getKnowledgeV2Enabled: () => knowledgeV2Enabled,
    });

    const resources = await service.getMemoryRuntimeResources(descriptor);
    expect(resources.memoryContextFile.path).toBe(sessionPath);
    expect(resources.memoryContextFile.content).toContain("Profile index line");
    expect(resources.memoryContextFile.content).toContain("Global index line");
    expect(resources.memoryContextFile.content).toContain("Session line");
    expect(resources.memoryContextFile.content).not.toContain("Legacy profile line");
    expect(resources.memoryContextFile.content).not.toContain("Legacy common fact");
    expect(resources.memoryContextFile.content).not.toContain("# Common Knowledge (maintained by Cortex");

    knowledgeV2Enabled = false;
    const legacyResources = await service.getMemoryRuntimeResources(descriptor);
    expect(legacyResources.memoryContextFile.content).toContain("Legacy profile line");
    expect(legacyResources.memoryContextFile.content).toContain("Legacy common fact");
    expect(legacyResources.memoryContextFile.content).not.toContain("Profile index line");
    expect(estimateTokens(resources.memoryContextFile.content)).toBeLessThan(
      estimateTokens(legacyResources.memoryContextFile.content),
    );
  });
});
