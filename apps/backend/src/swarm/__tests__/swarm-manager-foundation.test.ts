import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "../knowledge-service.js";
import { KnowledgeV2SettingsService } from "../knowledge-v2-settings-service.js";
import { createSwarmManagerFoundation } from "../swarm-manager-foundation.js";
import type { SessionPinCoordinatorHost } from "../session-pin-coordinator.js";
import type { SwarmConfig } from "../types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeConfig(): Promise<SwarmConfig> {
  const rootDir = await mkdtemp(join(tmpdir(), "forge-manager-foundation-"));
  cleanupPaths.push(rootDir);
  const dataDir = join(rootDir, "data");

  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    runtimeTarget: "builder",
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
    },
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
      sessionsDir: join(dataDir, "sessions"),
      memoryDir: join(dataDir, "memory"),
      authDir: join(dataDir, "auth"),
      authFile: join(dataDir, "auth", "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir: join(rootDir, "agent"),
      managerAgentDir: join(rootDir, "manager-agent"),
      repoArchetypesDir: join(rootDir, "archetypes"),
      repoMemorySkillFile: join(rootDir, "memory-skill.md"),
    },
  };
}

function lazyPinHost(): SessionPinCoordinatorHost {
  const fail = () => {
    throw new Error("late session-pin dependency was read during composition");
  };
  return {
    listSessions: fail,
    requireSession: fail,
    requireBuilderSession: fail,
    assertMutable: fail,
    getConversationHistory: fail,
    getRuntime: fail,
    patchDescriptor: fail,
    setConversationMessagePinned: fail,
    captureRuntimePromptMeta: fail,
    emitMessagePinned: fail,
    emitAgentsSnapshot: fail,
    logDebug: fail,
  };
}

describe("createSwarmManagerFoundation", () => {
  it("constructs the acyclic foundation in its documented order", async () => {
    const config = await makeConfig();
    const getConfiguredManagerId = vi.fn(() => "manager");
    const getRuntimeToken = vi.fn(() => {
      throw new Error("runtime controller was read during foundation composition");
    });

    const foundation = createSwarmManagerFoundation({
      config,
      descriptors: new Map(),
      profiles: new Map(),
      now: () => "2026-07-13T12:00:00.000Z",
      getConfiguredManagerId,
      getRuntimeToken,
      sessionPins: lazyPinHost(),
      logDebug: vi.fn(),
    });

    expect(getConfiguredManagerId).toHaveBeenCalledOnce();
    expect(getRuntimeToken).not.toHaveBeenCalled();
    expect(foundation.config).not.toBe(config);
    expect(foundation.config.defaultModel.modelId).toBe("gpt-5.5");
    expect(foundation.promptRegistry).toBeDefined();
    expect(foundation.sessionDescriptorFactory).toBeDefined();
    expect(foundation.sessionPinCoordinator).toBeDefined();
    expect(foundation.secretsEnvService).toBeDefined();
  });

  it("preserves explicit knowledge and compaction overrides by identity", async () => {
    const config = await makeConfig();
    const knowledgeV2SettingsService = new KnowledgeV2SettingsService({
      dataDir: config.paths.dataDir,
    });
    const knowledgeService = new KnowledgeService({
      dataDir: config.paths.dataDir,
      settingsService: knowledgeV2SettingsService,
    });
    const compactionRuntimeSettingsProvider = {
      getCompactionRuntimeSettings: () => ({
        timeoutMs: 1234,
        model: { provider: "openai-codex", modelId: "gpt-5.4" },
        reasoningLevel: "high" as const,
      }),
    };

    const foundation = createSwarmManagerFoundation({
      config,
      descriptors: new Map(),
      profiles: new Map(),
      now: () => "2026-07-13T12:00:00.000Z",
      getConfiguredManagerId: () => "manager",
      getRuntimeToken: () => undefined,
      sessionPins: lazyPinHost(),
      logDebug: vi.fn(),
      overrides: {
        knowledgeV2SettingsService,
        knowledgeService,
        compactionRuntimeSettingsProvider,
      },
    });

    expect(foundation.knowledgeV2SettingsService).toBe(knowledgeV2SettingsService);
    expect(foundation.knowledgeService).toBe(knowledgeService);
    expect(foundation.compactionRuntimeSettingsProvider).toBe(compactionRuntimeSettingsProvider);
    expect(foundation.liveCompactionRuntimeSettingsProvider).not.toBe(
      compactionRuntimeSettingsProvider,
    );
  });
});
