import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const piAiMockState = vi.hoisted(() => ({
  getModel: vi.fn()
}));

const piCodingAgentMockState = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  modelRegistryFind: vi.fn(),
  modelRegistryGetAll: vi.fn()
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: (...args: unknown[]) => piAiMockState.getModel(...args)
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({}))
  },
  DefaultResourceLoader: class {
    constructor(_options: unknown) {}

    async reload(): Promise<void> {}

    getPathMetadata(): Map<string, unknown> {
      return new Map();
    }
  },
  createAgentSession: (...args: unknown[]) => piCodingAgentMockState.createAgentSession(...args),
  ModelRegistry: class {
    constructor(_authStorage: unknown) {}

    find(provider: string, modelId: string): unknown {
      return piCodingAgentMockState.modelRegistryFind(provider, modelId);
    }

    getAll(): unknown[] {
      return piCodingAgentMockState.modelRegistryGetAll();
    }
  }
}));

import { RuntimeFactory } from "../runtime-factory.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

function createConfig(rootDir: string): SwarmConfig {
  const dataDir = join(rootDir, "data");

  return {
    host: "127.0.0.1",
    port: 47187,
    debug: false,
    isDesktop: false,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkingLevel: "high"
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
      sharedAuthDir: join(dataDir, "shared", "auth"),
      sharedAuthFile: join(dataDir, "shared", "auth", "auth.json"),
      sharedSecretsFile: join(dataDir, "shared", "secrets.json"),
      sharedIntegrationsDir: join(dataDir, "shared", "integrations"),
      sessionsDir: join(dataDir, "sessions"),
      memoryDir: join(dataDir, "memory"),
      authDir: join(dataDir, "auth"),
      authFile: join(dataDir, "auth", "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir: join(rootDir, "agent"),
      managerAgentDir: join(rootDir, "manager-agent"),
      repoArchetypesDir: join(rootDir, "archetypes"),
      repoMemorySkillFile: join(rootDir, "memory-skill.md")
    }
  };
}

function createDescriptor(rootDir: string): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: rootDir,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high"
    },
    sessionFile: join(rootDir, "session.jsonl")
  };
}

describe("RuntimeFactory", () => {
  beforeEach(() => {
    piAiMockState.getModel.mockReset();
    piCodingAgentMockState.createAgentSession.mockReset();
    piCodingAgentMockState.modelRegistryFind.mockReset();
    piCodingAgentMockState.modelRegistryGetAll.mockReset();
  });

  it("throws when the requested Pi model is unavailable instead of falling back", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    piCodingAgentMockState.modelRegistryFind.mockReturnValue(undefined);
    piCodingAgentMockState.modelRegistryGetAll.mockReturnValue([
      {
        provider: "openai-codex",
        modelId: "gpt-5.4"
      }
    ]);
    piAiMockState.getModel.mockReturnValue(undefined);

    const factory = new RuntimeFactory({
      host: {
        listAgents: () => [],
        getWorkerActivity: () => undefined,
        spawnAgent: async () => {
          throw new Error("not implemented");
        },
        killAgent: async () => {},
        sendMessage: async () => ({
          targetAgentId: "worker-1",
          deliveryId: "delivery-1",
          acceptedMode: "prompt"
        }),
        publishToUser: async () => ({
          targetContext: { channel: "web" }
        }),
        requestUserChoice: async () => []
      },
      config: createConfig(rootDir),
      now: () => "2026-01-01T00:00:00.000Z",
      logDebug: () => {},
      getMemoryRuntimeResources: async () => ({
        memoryContextFile: {
          path: join(rootDir, "memory.md"),
          content: ""
        },
        additionalSkillPaths: []
      }),
      getSwarmContextFiles: async () => [],
      mergeRuntimeContextFiles: (base) => base,
      callbacks: {
        onStatusChange: async () => {},
        onSessionEvent: async () => {},
        onAgentEnd: async () => {},
        onRuntimeError: async () => {},
        onRuntimeExtensionSnapshot: async () => {}
      }
    });

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt")).rejects.toThrow(
      'Model "gpt-5.4-mini" not found for provider "openai-codex". The model may not be available in the current Pi runtime version.'
    );

    expect(piCodingAgentMockState.modelRegistryGetAll).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });
});
