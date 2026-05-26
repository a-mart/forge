import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCollaborationSkillsOverride,
  planPiResourceLoaderOptions,
  planRuntimeEnv,
  planRuntimeResourcePaths,
  type RuntimeMemoryResourcesPlan,
} from "../runtime/runtime-resource-plan.js";
import type { PiRuntimePromptPlan } from "../runtime/runtime-prompt-plan.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

function createConfig(rootDir: string): SwarmConfig {
  const dataDir = join(rootDir, "data");
  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    defaultCwd: rootDir,
    cwdAllowlistRoots: [rootDir],
    paths: {
      rootDir,
      dataDir,
      swarmDir: join(dataDir, "swarm"),
      uploadsDir: join(dataDir, "uploads"),
      agentsStoreFile: join(dataDir, "swarm", "agents.json"),
      profilesDir: join(dataDir, "profiles"),
      sharedDir: join(dataDir, "shared"),
      sharedConfigDir: join(dataDir, "shared", "config"),
      sharedCacheDir: join(dataDir, "shared", "cache"),
      sharedStateDir: join(dataDir, "shared", "state"),
      sharedAuthDir: join(dataDir, "shared", "config", "auth"),
      sharedAuthFile: join(dataDir, "shared", "config", "auth", "auth.json"),
      sharedSecretsFile: join(dataDir, "shared", "config", "secrets.json"),
      sharedIntegrationsDir: join(dataDir, "shared", "config", "integrations"),
      sessionsDir: join(dataDir, "sessions"),
      memoryDir: join(dataDir, "memory"),
      authDir: join(dataDir, "auth"),
      authFile: join(dataDir, "auth", "auth.json"),
      configDir: join(dataDir, "config"),
      integrationsDir: join(dataDir, "integrations"),
      schedulesDir: join(dataDir, "schedules"),
      agentDir: join(dataDir, "agent"),
      managerAgentDir: join(dataDir, "agent", "manager"),
    },
  };
}

function descriptor(overrides: Partial<AgentDescriptor>): AgentDescriptor {
  return {
    agentId: "agent-1",
    role: "manager",
    status: "idle",
    cwd: "/tmp/project",
    sessionFile: "/tmp/session.jsonl",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    ...overrides,
  } as AgentDescriptor;
}

function memoryResources(rootDir: string, metadata: SkillMetadata[] = []): RuntimeMemoryResourcesPlan {
  return {
    memoryContextFile: { path: join(rootDir, "memory.md"), content: "memory" },
    additionalSkillPaths: [join(rootDir, "memory-skills")],
    skillMetadata: metadata,
  };
}

function skillMetadata(rootDir: string, directoryName: string): SkillMetadata {
  return {
    skillId: `global:${directoryName}`,
    skillName: directoryName,
    directoryName,
    path: join(rootDir, directoryName, "SKILL.md"),
    rootPath: join(rootDir, directoryName),
    env: [],
    sourceKind: "global",
    isInherited: false,
    isEffective: true,
  };
}

describe("runtime resource plan", () => {
  it("plans manager and worker runtime agent dirs with profile ID fallback", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-resource-"));
    const config = createConfig(rootDir);

    const managerPlan = planRuntimeResourcePaths({ config, descriptor: descriptor({ role: "manager", agentId: "manager-a" }) });
    expect(managerPlan.runtimeAgentDir).toBe(config.paths.managerAgentDir);
    expect(managerPlan.profileId).toBe("manager-a");

    const workerPlan = planRuntimeResourcePaths({
      config,
      descriptor: descriptor({ role: "worker", agentId: "worker-a", managerId: "manager-a", profileId: "profile-a" }),
    });
    expect(workerPlan.runtimeAgentDir).toBe(config.paths.agentDir);
    expect(workerPlan.profileId).toBe("profile-a");
  });

  it("includes only non-empty Builder Pi profile overlay dirs without broad skill-dir loading", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-resource-"));
    const config = createConfig(rootDir);
    const agent = descriptor({ profileId: "builder" });
    const pathsPlan = planRuntimeResourcePaths({ config, descriptor: agent });
    mkdirSync(pathsPlan.profilePiExtensionsDir, { recursive: true });
    mkdirSync(pathsPlan.profilePiSkillsDir, { recursive: true });
    mkdirSync(pathsPlan.profilePiPromptsDir, { recursive: true });
    mkdirSync(pathsPlan.profilePiThemesDir, { recursive: true });
    writeFileSync(join(pathsPlan.profilePiExtensionsDir, "extension.ts"), "export default {};", "utf8");
    writeFileSync(join(pathsPlan.profilePiSkillsDir, "SKILL.md"), "---\nname: builder\n---", "utf8");
    writeFileSync(join(pathsPlan.profilePiThemesDir, "theme.json"), "{}", "utf8");

    const plan = planPiResourceLoaderOptions({
      descriptor: agent,
      pathsPlan,
      memoryResources: memoryResources(rootDir),
      promptPlan: { systemPrompt: "prompt", appendSystemPromptOverride: () => [] },
      swarmContextFiles: [],
      extensionFactories: [],
      isCollaborationRuntime: false,
      mergeRuntimeContextFiles: (base) => base,
    });

    expect(plan.additionalExtensionPaths).toEqual([pathsPlan.profilePiExtensionsDir]);
    expect(plan.additionalSkillPaths).toEqual([join(rootDir, "memory-skills")]);
    expect(plan.additionalSkillPaths).not.toContain(pathsPlan.profilePiSkillsDir);
    expect(plan.additionalPromptTemplatePaths).toEqual([]);
    expect(plan.additionalThemePaths).toEqual([pathsPlan.profilePiThemesDir]);
  });

  it("excludes profile skill dirs for collaboration and admits selected memory skills by handle and path/rootPath only", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-resource-"));
    const config = createConfig(rootDir);
    const agent = descriptor({ profileId: "collab" });
    const pathsPlan = planRuntimeResourcePaths({ config, descriptor: agent });
    mkdirSync(pathsPlan.profilePiSkillsDir, { recursive: true });
    writeFileSync(join(pathsPlan.profilePiSkillsDir, "SKILL.md"), "profile skill", "utf8");
    const allowed = skillMetadata(join(rootDir, "allowed"), "Researcher");

    const plan = planPiResourceLoaderOptions({
      descriptor: agent,
      pathsPlan,
      memoryResources: memoryResources(rootDir, [allowed]),
      promptPlan: { systemPrompt: "prompt", appendSystemPromptOverride: () => [] },
      swarmContextFiles: [],
      extensionFactories: [],
      isCollaborationRuntime: true,
      mergeRuntimeContextFiles: (base) => base,
    });

    expect(plan.additionalSkillPaths).toEqual([join(rootDir, "memory-skills")]);
    expect(plan.skillsOverride).toEqual(expect.any(Function));

    const diagnostics = [{ level: "warn", message: "kept" }];
    const result = plan.skillsOverride!({
      skills: [
        { baseDir: allowed.rootPath, filePath: join(rootDir, "wrong", "Researcher", "SKILL.md") },
        { baseDir: join(rootDir, "other", "Researcher"), filePath: allowed.path },
        { baseDir: join(rootDir, "other", "Researcher"), filePath: join(rootDir, "wrong", "Researcher", "SKILL.md") },
        { baseDir: join(rootDir, "other", "Different"), filePath: allowed.path },
      ] as never,
      diagnostics: diagnostics as never,
    });

    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]).toMatchObject({ baseDir: allowed.rootPath });
    expect(result.skills[1]).toMatchObject({ filePath: allowed.path });
    expect(result.diagnostics).toBe(diagnostics);
  });

  it("merges agents files before appending startup recovery context", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-resource-"));
    const config = createConfig(rootDir);
    const agent = descriptor({ profileId: "builder" });
    const pathsPlan = planRuntimeResourcePaths({ config, descriptor: agent });
    const promptPlan: PiRuntimePromptPlan = {
      systemPrompt: "prompt",
      appendSystemPromptOverride: () => [],
      startupRecoveryContextFile: { path: join(rootDir, "recovery.md"), content: "recovery" },
    };

    const plan = planPiResourceLoaderOptions({
      descriptor: agent,
      pathsPlan,
      memoryResources: memoryResources(rootDir),
      promptPlan,
      swarmContextFiles: [{ path: join(rootDir, "AGENTS.md"), content: "agents" }],
      extensionFactories: [],
      isCollaborationRuntime: false,
      mergeRuntimeContextFiles: (base, options) => [
        ...base,
        options.memoryContextFile,
        ...options.swarmContextFiles,
      ],
    });

    expect(plan.agentsFilesOverride({ agentsFiles: [{ path: join(rootDir, "base.md"), content: "base" }] }).agentsFiles)
      .toEqual([
        { path: join(rootDir, "base.md"), content: "base" },
        { path: join(rootDir, "memory.md"), content: "memory" },
        { path: join(rootDir, "AGENTS.md"), content: "agents" },
        { path: join(rootDir, "recovery.md"), content: "recovery" },
      ]);
  });

  it("plans exact Claude/Cursor SDK runtime env values", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-resource-"));
    const config = createConfig(rootDir);
    expect(planRuntimeEnv({ dataDir: config.paths.dataDir, memoryContextFile: { path: join(rootDir, "memory.md"), content: "" } }))
      .toEqual({ SWARM_DATA_DIR: config.paths.dataDir, SWARM_MEMORY_FILE: join(rootDir, "memory.md") });
  });

  it("exports the collaboration skills override helper for direct path matching", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-resource-"));
    const allowed = skillMetadata(join(rootDir, "skills"), "memory");
    const override = buildCollaborationSkillsOverride([allowed]);

    expect(override({ skills: [{ baseDir: allowed.rootPath, filePath: allowed.path }] as never, diagnostics: [] }).skills)
      .toHaveLength(1);
  });
});
