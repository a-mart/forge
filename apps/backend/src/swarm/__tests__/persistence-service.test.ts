import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempConfig } from "../../test-support/index.js";
import { PersistenceService } from "../persistence-service.js";
import { getConversationHistoryCacheFilePath } from "../conversation-history-cache.js";
import { getSharedKnowledgeDir } from "../data-paths.js";
import { extractDescriptorAgentId, validateAgentDescriptor } from "../swarm-manager-utils.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../types.js";

function descriptor(config: SwarmConfig, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "manager",
    displayName: "Manager",
    role: "manager",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, "manager.jsonl"),
    ...overrides,
  };
}

function createPersistenceService(
  config: SwarmConfig,
  agents: AgentDescriptor[] = [],
  profiles: ManagerProfile[] = [],
): PersistenceService {
  const descriptors = new Map(agents.map((agent) => [agent.agentId, agent]));
  return new PersistenceService({
    config,
    descriptors,
    sortedDescriptors: () => agents,
    sortedProfiles: () => profiles,
    getConfiguredManagerId: () => config.managerId,
    resolveMemoryOwnerAgentId: (agent) => agent.managerId,
    validateAgentDescriptor,
    extractDescriptorAgentId,
    logDebug: vi.fn(),
  });
}

async function writeStore(config: SwarmConfig, agents: unknown[], profiles: ManagerProfile[] = []): Promise<void> {
  await mkdir(join(config.paths.dataDir, "swarm"), { recursive: true });
  await writeFile(config.paths.agentsStoreFile, `${JSON.stringify({ agents, profiles }, null, 2)}\n`, "utf8");
}

describe("PersistenceService", () => {
  it("provisions directories and saves the canonical descriptor store", async () => {
    const config = await makeTempConfig();
    const agent = descriptor(config);
    const profile: ManagerProfile = {
      profileId: "manager",
      displayName: "Manager",
      defaultSessionAgentId: "manager",
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      defaultModel: config.defaultModel,
    };
    const service = createPersistenceService(config, [agent], [profile]);
    await service.ensureDirectories();
    await service.ensureProfileDirectories("manager");
    await expect(stat(getSharedKnowledgeDir(config.paths.dataDir))).resolves.toBeTruthy();
    await expect(stat(join(config.paths.dataDir, "profiles", "manager", "pi", "skills"))).resolves.toBeTruthy();
    await service.saveStore();
    expect(JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8"))).toEqual({ agents: [agent], profiles: [profile] });
  });

  it("does not overwrite memory files and deletes paired session/cache files", async () => {
    const config = await makeTempConfig();
    const service = createPersistenceService(config);
    const memoryPath = join(config.paths.dataDir, "profiles", "manager", "memory.md");
    await service.ensureAgentMemoryFile(memoryPath, "initial");
    await writeFile(memoryPath, "user-authored", "utf8");
    await service.ensureAgentMemoryFile(memoryPath, "replacement");
    expect(await readFile(memoryPath, "utf8")).toBe("user-authored");

    const sessionFile = join(config.paths.sessionsDir, "manager.jsonl");
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile);
    await mkdir(join(config.paths.sessionsDir, "..", "cache"), { recursive: true });
    await writeFile(sessionFile, "session", "utf8");
    await writeFile(cacheFile, "cache", "utf8");
    await service.deleteManagerSessionFile(sessionFile);
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves persisted descriptor fields that future descriptor seams must not drop", async () => {
    const config = await makeTempConfig();
    const persisted = descriptor(config, {
      agentId: "release-notes",
      displayName: "Release Notes",
      managerId: "release-notes",
      profileId: "manager",
      sessionLabel: "Release notes",
      sessionPurpose: "agent_creator",
      sessionSurface: "collab",
      collab: { workspaceId: "workspace-1", channelId: "channel-1" },
      creatorAgentId: "agent-architect",
      sessionSystemPrompt: "Use this session-specific prompt.",
      pinnedAt: "2026-01-02T00:00:00.000Z",
      mergedAt: "2026-01-03T00:00:00.000Z",
      compactionCount: 3,
      workerCount: 5,
      activeWorkerCount: 2,
      streamingStartedAt: 123456,
      pendingChoiceCount: 1,
      specialistId: "backend-specialist",
      specialistDisplayName: "Backend Specialist",
      specialistColor: "blue",
      modelOrigin: "session_override",
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        thinkingLevel: "xhigh",
      } as AgentDescriptor["model"],
      contextUsage: { tokens: 1234, contextWindow: 200000, percent: 0.617 },
      projectAgent: {
        handle: "release-notes",
        whenToUse: "Draft release notes.",
        systemPrompt: "You are the release notes project agent.",
        creatorSessionId: "agent-creator-session",
        capabilities: ["create_session"],
      },
      agentCreatorResult: {
        createdAgentId: "release-notes",
        createdHandle: "release-notes",
        createdAt: "2026-01-04T00:00:00.000Z",
      },
      webSearch: true,
    });
    const profiles: ManagerProfile[] = [
      {
        profileId: "manager",
        displayName: "Manager Profile",
        defaultSessionAgentId: "manager",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        defaultModel: config.defaultModel,
      },
    ];
    await writeStore(config, [persisted], profiles);

    const loaded = await createPersistenceService(config).loadStore();

    expect(loaded.profiles).toEqual(profiles);
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0]).toEqual(persisted);
  });

  it("skips invalid descriptors, warns with descriptor hints, and keeps valid neighbors", async () => {
    const config = await makeTempConfig();
    const valid = descriptor(config, { agentId: "valid-manager" });
    await writeStore(config, [
      { agentId: "broken", role: "manager" },
      { displayName: "missing id" },
      valid,
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = await createPersistenceService(config).loadStore();

    expect(loaded.agents).toEqual([valid]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("agentId=broken");
    expect(warn.mock.calls[1]?.[0]).toContain("index=1");
    warn.mockRestore();
  });

  it.each([
    [".forge", ".middleman"],
    ["forge", "middleman"],
  ])("normalizes legacy %s sessionFile paths from matching %s data directories", async (currentName, legacyName) => {
    const baseConfig = await makeTempConfig();
    const root = await mkdtemp(join(tmpdir(), "forge-path-normalization-"));
    const dataDir = resolve(root, currentName);
    const legacyDataDir = resolve(root, legacyName);
    const config: SwarmConfig = {
      ...baseConfig,
      paths: {
        ...baseConfig.paths,
        dataDir,
        swarmDir: join(dataDir, "swarm"),
        agentsStoreFile: join(dataDir, "swarm", "agents.json"),
        sessionsDir: join(dataDir, "sessions"),
      },
    };
    const legacySessionFile = join(legacyDataDir, "profiles", "manager", "sessions", "manager", "session.jsonl");
    const currentSessionFile = join(dataDir, "profiles", "manager", "sessions", "manager", "session.jsonl");
    await writeStore(config, [descriptor(config, { sessionFile: legacySessionFile })]);

    const loaded = await createPersistenceService(config).loadStore();

    expect(loaded.agents[0]?.sessionFile).toBe(currentSessionFile);
  });

  it("normalizes stopped_on_restart descriptors to stopped during store load", async () => {
    const config = await makeTempConfig();
    await writeStore(config, [descriptor(config, { status: "stopped_on_restart" })]);

    const loaded = await createPersistenceService(config).loadStore();

    expect(loaded.agents[0]?.status).toBe("stopped");
  });

  it("returns an empty store for missing, malformed, or non-array agent stores", async () => {
    const config = await makeTempConfig();
    await writeFile(config.paths.agentsStoreFile, "not json", "utf8");
    await expect(createPersistenceService(config).loadStore()).resolves.toEqual({ agents: [], profiles: [] });

    await writeFile(config.paths.agentsStoreFile, JSON.stringify({ agents: {} }), "utf8");
    await expect(createPersistenceService(config).loadStore()).resolves.toEqual({ agents: [], profiles: [] });
  });
});
