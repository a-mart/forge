import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDescriptor, createTempConfig, type TempConfigHandle } from "../../test-support/index.js";
import { getSessionFilePath } from "../data-paths.js";
import { readSessionMeta, writeSessionMeta } from "../session-manifest.js";
import { SwarmSessionMetaService } from "../swarm-session-meta-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

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

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

async function makeConfig(): Promise<SwarmConfig> {
  const handle = await createTempConfig({
    prefix: "swarm-session-meta-service-",
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
  return handle.config;
}

function managerSessionFile(config: SwarmConfig, agentId: string): string {
  return join(config.paths.profilesDir, "manager", "sessions", agentId, "session.jsonl");
}

function buildService(
  config: SwarmConfig,
  descriptors: Map<string, AgentDescriptor>,
  options: {
    resolveSystemPromptForDescriptor?: (d: AgentDescriptor) => Promise<string>;
    now?: () => string;
    emitAgentsSnapshot?: ReturnType<typeof vi.fn>;
    logDebug?: ReturnType<typeof vi.fn>;
  } = {}
): SwarmSessionMetaService {
  let tick = 0;
  return new SwarmSessionMetaService({
    dataDir: config.paths.dataDir,
    agentsStoreFile: config.paths.agentsStoreFile,
    descriptors,
    getSortedDescriptors: () => Array.from(descriptors.values()),
    now: options.now ?? (() => `2026-01-01T00:00:0${tick++}.000Z`),
    logDebug: options.logDebug ?? vi.fn(),
    emitAgentsSnapshot: options.emitAgentsSnapshot ?? vi.fn(),
    ensureSkillMetadataLoaded: async () => {},
    getAdditionalSkillPaths: () => ["/skills/a/SKILL.md", "/skills/b/SKILL.md"],
    getAgentMemoryPath: (agentId) => join(config.paths.dataDir, "memory-paths", `${agentId}.md`),
    resolveSystemPromptForDescriptor:
      options.resolveSystemPromptForDescriptor ?? (async () => "resolved-prompt-for-meta")
  });
}

describe("SwarmSessionMetaService", () => {
  it("writeInitialSessionMeta creates session meta with model, label, and timestamps", async () => {
    const config = await makeConfig();
    const dataDir = config.paths.dataDir;
    const sessionFile = managerSessionFile(config, "manager");
    await mkdir(join(dataDir, "profiles", "manager", "sessions", "manager"), { recursive: true });
    await writeFile(sessionFile, "", "utf8");

    const descriptor = createAgentDescriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "manager",
      sessionLabel: "Main",
      rootDir: config.defaultCwd,
      sessionFile,
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" }
    }) as AgentDescriptor & { role: "manager"; profileId: string };

    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const service = buildService(config, descriptors);

    await service.writeInitialSessionMeta(descriptor);

    const meta = await readSessionMeta(dataDir, "manager", "manager");
    expect(meta?.sessionId).toBe("manager");
    expect(meta?.label).toBe("Main");
    expect(meta?.model).toEqual({ provider: "openai-codex", modelId: "gpt-5.4" });
    expect(meta?.cwd).toBe(descriptor.cwd);
  });

  it("captureSessionRuntimePromptMeta records prompt fingerprint and resolved system prompt", async () => {
    const config = await makeConfig();
    const dataDir = config.paths.dataDir;
    const sessionFile = managerSessionFile(config, "manager");
    await mkdir(join(dataDir, "profiles", "manager", "sessions", "manager"), { recursive: true });
    await writeFile(sessionFile, "", "utf8");

    const descriptor = createAgentDescriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "manager",
      archetypeId: "manager",
      rootDir: config.defaultCwd,
      sessionFile,
      model: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "medium" }
    }) as AgentDescriptor & { role: "manager"; profileId: string };

    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const service = buildService(config, descriptors);

    await service.captureSessionRuntimePromptMeta(descriptor, "explicit-runtime-prompt");

    const meta = await readSessionMeta(dataDir, "manager", "manager");
    expect(meta?.resolvedSystemPrompt).toBe("explicit-runtime-prompt");
    expect(meta?.promptComponents?.archetype).toBe("manager");
    expect(meta?.promptComponents?.skills).toEqual(["/skills/a/SKILL.md", "/skills/b/SKILL.md"]);
    expect(meta?.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("updateSessionMetaForWorkerDescriptor upserts worker rows on the manager session meta", async () => {
    const config = await makeConfig();
    const dataDir = config.paths.dataDir;
    const managerSessionPath = managerSessionFile(config, "manager");
    await mkdir(join(dataDir, "profiles", "manager", "sessions", "manager"), { recursive: true });
    await writeFile(managerSessionPath, "", "utf8");

    const manager = createAgentDescriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "manager",
      rootDir: config.defaultCwd,
      sessionFile: managerSessionPath,
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" }
    }) as AgentDescriptor & { role: "manager"; profileId: string };

    const worker = createAgentDescriptor({
      agentId: "worker-1",
      role: "worker",
      managerId: "manager",
      profileId: "manager",
      specialistId: "backend",
      status: "streaming",
      rootDir: config.defaultCwd,
      sessionFile: join(config.paths.sessionsDir, "worker-1.jsonl"),
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" },
      contextUsage: { tokens: 42 }
    });

    const descriptors = new Map<string, AgentDescriptor>([
      ["manager", manager],
      ["worker-1", worker]
    ]);
    const service = buildService(config, descriptors);

    await service.writeInitialSessionMeta(manager);
    await service.updateSessionMetaForWorkerDescriptor(worker, "worker prompt text");

    const meta = await readSessionMeta(dataDir, "manager", "manager");
    expect(meta?.workers).toHaveLength(1);
    expect(meta?.workers[0]).toMatchObject({
      id: "worker-1",
      specialistId: "backend",
      status: "streaming",
      systemPrompt: "worker prompt text",
      tokens: { input: 42, output: null }
    });
  });

  it("refreshSessionMetaStats writes file sizes and creates meta when missing", async () => {
    const config = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const sessionAgentId = "manager";
    const sessionFile = getSessionFilePath(dataDir, profileId, sessionAgentId);
    const memoryPath = join(dataDir, "memory-paths", `${sessionAgentId}.md`);
    await mkdir(join(dataDir, "profiles", "manager", "sessions", "manager"), { recursive: true });
    await mkdir(join(dataDir, "memory-paths"), { recursive: true });
    await writeFile(sessionFile, "12345", "utf8");
    await writeFile(memoryPath, "abcde", "utf8");

    const descriptor = createAgentDescriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId,
      rootDir: config.defaultCwd,
      sessionFile,
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" }
    }) as AgentDescriptor & { role: "manager"; profileId: string };

    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const service = buildService(config, descriptors);

    await service.refreshSessionMetaStats(descriptor);

    const meta = await readSessionMeta(dataDir, profileId, sessionAgentId);
    expect(meta?.stats?.sessionFileSize).toBe("5");
    expect(meta?.stats?.memoryFileSize).toBe("5");
  });

  it("hydrateCompactionCountsForBoot hydrates manager descriptor compactionCount from meta", async () => {
    const config = await makeConfig();
    const dataDir = config.paths.dataDir;
    const sessionFile = managerSessionFile(config, "manager");
    await mkdir(join(dataDir, "profiles", "manager", "sessions", "manager"), { recursive: true });
    await writeFile(sessionFile, "", "utf8");

    const descriptor = createAgentDescriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "manager",
      rootDir: config.defaultCwd,
      sessionFile,
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" }
    }) as AgentDescriptor & { role: "manager"; profileId: string };

    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const service = buildService(config, descriptors);

    await service.writeInitialSessionMeta(descriptor);
    const existing = await readSessionMeta(dataDir, "manager", "manager");
    expect(existing).toBeDefined();
    await writeSessionMeta(dataDir, { ...existing!, compactionCount: 11 });

    descriptor.compactionCount = undefined;
    await service.hydrateCompactionCountsForBoot();
    expect(descriptor.compactionCount).toBe(11);
  });

  it("startCompactionCountBackfill updates descriptors and emits snapshot when JSONL compactions exist", async () => {
    const config = await makeConfig();
    const dataDir = config.paths.dataDir;
    const profileId = "manager";
    const sessionId = "manager";
    const sessionFile = getSessionFilePath(dataDir, profileId, sessionId);
    const metaPath = join(dataDir, "profiles", profileId, "sessions", sessionId, "meta.json");

    await mkdir(join(dataDir, "profiles", profileId, "sessions", sessionId), { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify({ type: "compaction", id: "c1" })}\n`, "utf8");
    await writeFile(
      metaPath,
      `${JSON.stringify({
        sessionId,
        profileId,
        label: null,
        model: { provider: "openai-codex", modelId: "gpt-5.4" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
        compactionCount: 0,
        resolvedSystemPrompt: null,
        promptFingerprint: null,
        promptComponents: null,
        workers: [],
        stats: {
          totalWorkers: 0,
          activeWorkers: 0,
          totalTokens: { input: null, output: null },
          sessionFileSize: null,
          memoryFileSize: null
        }
      })}\n`,
      "utf8"
    );

    const descriptor = createAgentDescriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId,
      rootDir: config.defaultCwd,
      sessionFile,
      model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" }
    }) as AgentDescriptor & { role: "manager"; profileId: string };

    const descriptors = new Map<string, AgentDescriptor>([["manager", descriptor]]);
    const emitAgentsSnapshot = vi.fn();
    const service = buildService(config, descriptors, { emitAgentsSnapshot });

    descriptor.compactionCount = 0;
    service.startCompactionCountBackfill();

    await vi.waitFor(
      () => {
        expect(descriptor.compactionCount).toBe(1);
      },
      { timeout: 5000 }
    );
    expect(emitAgentsSnapshot).toHaveBeenCalled();
  });
});
