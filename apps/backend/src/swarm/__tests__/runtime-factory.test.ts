import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const piAiMockState = vi.hoisted(() => ({
  getModel: vi.fn(),
  getModels: vi.fn((provider: unknown) =>
    provider === "xai"
      ? [
          {
            id: "grok-4",
            name: "Grok 4",
            api: "openai-completions",
            provider: "xai",
            baseUrl: "https://api.x.ai/v1",
            reasoning: true,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 123,
            maxTokens: 456,
          },
        ]
      : [],
  ),
}));

const piCodingAgentMockState = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  compact: vi.fn(),
  modelRegistryConstructorArgs: vi.fn(),
  modelRegistryFind: vi.fn(),
  modelRegistryGetAll: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: (provider: unknown, modelId: unknown) => piAiMockState.getModel(provider, modelId),
  getModels: (provider: unknown) => piAiMockState.getModels(provider),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({})),
  },
  DefaultResourceLoader: class {
    constructor(_options: unknown) {}

    async reload(): Promise<void> {}

    getPathMetadata(): Map<string, unknown> {
      return new Map();
    }
  },
  createAgentSession: (...args: unknown[]) => piCodingAgentMockState.createAgentSession(...args),
  compact: (...args: unknown[]) => piCodingAgentMockState.compact(...args),
  ModelRegistry: class {
    constructor(_authStorage: unknown, modelsJsonPath?: unknown) {
      piCodingAgentMockState.modelRegistryConstructorArgs(_authStorage, modelsJsonPath);
    }

    getError(): undefined {
      return undefined;
    }

    find(provider: string, modelId: string): unknown {
      return piCodingAgentMockState.modelRegistryFind(provider, modelId);
    }

    getAll(): unknown[] {
      return piCodingAgentMockState.modelRegistryGetAll();
    }
  },
}));

import { savePins } from "../message-pins.js";
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
      repoMemorySkillFile: join(rootDir, "memory-skill.md"),
    },
  };
}

function createDescriptor(
  rootDir: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
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
      thinkingLevel: "high",
    },
    sessionFile: join(rootDir, "session.jsonl"),
    ...overrides,
  };
}

function createManagerDescriptor(rootDir: string): AgentDescriptor {
  return createDescriptor(rootDir, {
    agentId: "manager-1",
    displayName: "Manager 1",
    role: "manager",
    managerId: "manager-1",
    sessionFile: join(rootDir, "manager-session.jsonl"),
  });
}

async function seedProjectionFile(rootDir: string): Promise<string> {
  const projectionPath = join(rootDir, "data", "shared", "generated", "pi-models.json");
  await mkdir(join(rootDir, "data", "shared", "generated"), { recursive: true });
  await writeFile(projectionPath, '{"providers":{}}\n', "utf8");
  return projectionPath;
}

function createFactory(rootDir: string): RuntimeFactory {
  return new RuntimeFactory({
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
        acceptedMode: "prompt",
      }),
      publishToUser: async () => ({
        targetContext: { channel: "web" },
      }),
      requestUserChoice: async () => [],
    },
    config: createConfig(rootDir),
    now: () => "2026-01-01T00:00:00.000Z",
    logDebug: () => {},
    getPiModelsJsonPath: () => join(rootDir, "data", "shared", "generated", "pi-models.json"),
    getMemoryRuntimeResources: async () => ({
      memoryContextFile: {
        path: join(rootDir, "memory.md"),
        content: "",
      },
      additionalSkillPaths: [],
    }),
    getSwarmContextFiles: async () => [],
    mergeRuntimeContextFiles: (base) => base,
    callbacks: {
      onStatusChange: async () => {},
      onSessionEvent: async () => {},
      onAgentEnd: async () => {},
      onRuntimeError: async () => {},
      onRuntimeExtensionSnapshot: async () => {},
    },
  });
}

function buildExtensionFactories(factory: RuntimeFactory, descriptor: AgentDescriptor) {
  return (
    factory as unknown as {
      buildExtensionFactories: (agentDescriptor: AgentDescriptor) => Array<(pi: any) => void>;
    }
  ).buildExtensionFactories(descriptor);
}

describe("RuntimeFactory", () => {
  beforeEach(() => {
    piAiMockState.getModel.mockReset();
    piAiMockState.getModels.mockClear();
    piCodingAgentMockState.createAgentSession.mockReset();
    piCodingAgentMockState.compact.mockReset();
    piCodingAgentMockState.modelRegistryConstructorArgs.mockReset();
    piCodingAgentMockState.modelRegistryFind.mockReset();
    piCodingAgentMockState.modelRegistryGetAll.mockReset();
  });

  it("throws when the requested Pi model is unavailable instead of falling back", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    await seedProjectionFile(rootDir);

    piCodingAgentMockState.modelRegistryFind.mockReturnValue(undefined);
    piCodingAgentMockState.modelRegistryGetAll.mockReturnValue([
      {
        provider: "openai-codex",
        modelId: "gpt-5.4",
      },
    ]);
    piAiMockState.getModel.mockReturnValue(undefined);

    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt")).rejects.toThrow(
      'Model "gpt-5.4-mini" not found for provider "openai-codex".',
    );

    expect(piCodingAgentMockState.modelRegistryConstructorArgs).toHaveBeenCalledWith(
      expect.anything(),
      join(rootDir, "data", "shared", "generated", "pi-models.json"),
    );
    expect(piCodingAgentMockState.modelRegistryGetAll).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("fails fast when the generated Pi projection file is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt")).rejects.toThrow(
      `Pi model projection file is missing: ${join(rootDir, "data", "shared", "generated", "pi-models.json")}. Regenerate it before creating a ModelRegistry.`,
    );

    expect(piCodingAgentMockState.modelRegistryConstructorArgs).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("passes auth headers and custom instructions to Pi compaction in the correct argument order", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const factory = createFactory(rootDir);
    const descriptor = createManagerDescriptor(rootDir);
    await savePins(join(rootDir, "data", "profiles", descriptor.profileId!, "sessions", descriptor.agentId), {
      version: 1,
      pins: {
        "msg-1": {
          pinnedAt: "2026-01-01T00:00:00.000Z",
          role: "user",
          text: "Keep this exact wording",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const extensionFactories = buildExtensionFactories(factory, descriptor);

    const handlers = new Map<string, (...args: any[]) => unknown>();
    for (const extensionFactory of extensionFactories) {
      extensionFactory({
        on: (event: string, handler: (...args: any[]) => unknown) => {
          handlers.set(event, handler);
        },
      });
    }

    const beforeCompact = handlers.get("session_before_compact");
    expect(beforeCompact).toBeTypeOf("function");

    piCodingAgentMockState.compact.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 123,
    });

    const signal = new AbortController().signal;
    const result = await beforeCompact?.(
      {
        preparation: {
          firstKeptEntryId: "entry-1",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 123,
          fileOps: { readFiles: [], modifiedFiles: [] },
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
        },
        branchEntries: [],
        customInstructions: "Focus on deployment details.",
        signal,
      },
      {
        model: { provider: "openai-codex", id: "gpt-5.4" },
        modelRegistry: {
          getApiKeyAndHeaders: vi.fn().mockResolvedValue({
            ok: true,
            apiKey: "oauth-access-token",
            headers: { Authorization: "Bearer oauth-access-token", "x-test": "1" },
          }),
        },
        ui: { notify: vi.fn() },
      },
    );

    expect(piCodingAgentMockState.compact).toHaveBeenCalledWith(
      {
        firstKeptEntryId: "entry-1",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 123,
        fileOps: { readFiles: [], modifiedFiles: [] },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
      },
      { provider: "openai-codex", id: "gpt-5.4" },
      "oauth-access-token",
      { Authorization: "Bearer oauth-access-token", "x-test": "1" },
      expect.stringContaining("Focus on deployment details."),
      signal,
    );
    expect(result).toEqual({
      compaction: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      },
    });
  });

  it("injects the catalog request behavior extension for xAI workers without re-registering the provider", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "xai",
        modelId: "grok-4",
        thinkingLevel: "high",
      },
    });

    const extensionFactories = buildExtensionFactories(factory, descriptor);
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const registerProvider = vi.fn();

    for (const extensionFactory of extensionFactories) {
      extensionFactory({
        registerProvider,
        on: (event: string, handler: (...args: any[]) => unknown) => {
          handlers.set(event, handler);
        },
      } as any);
    }

    expect(registerProvider).not.toHaveBeenCalled();
    expect(handlers.has("before_provider_request")).toBe(true);
  });

  it("does not inject request-behavior handling for non-xAI workers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.4",
        thinkingLevel: "high",
      },
    });

    const extensionFactories = buildExtensionFactories(factory, descriptor);
    const handlers = new Map<string, (...args: any[]) => unknown>();

    for (const extensionFactory of extensionFactories) {
      extensionFactory({
        registerProvider: vi.fn(),
        on: (event: string, handler: (...args: any[]) => unknown) => {
          handlers.set(event, handler);
        },
      } as any);
    }

    expect(handlers.has("before_provider_request")).toBe(false);
  });

  it("registers before_provider_request injection when xAI web search is enabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "xai",
        modelId: "grok-4",
        thinkingLevel: "high",
      },
      webSearch: true,
    });

    const extensionFactories = buildExtensionFactories(factory, descriptor);
    const handlers = new Map<string, (...args: any[]) => unknown>();

    for (const extensionFactory of extensionFactories) {
      extensionFactory({
        registerProvider: vi.fn(),
        on: (event: string, handler: (...args: any[]) => unknown) => {
          handlers.set(event, handler);
        },
      } as any);
    }

    const beforeProviderRequest = handlers.get("before_provider_request");
    expect(beforeProviderRequest).toBeTypeOf("function");

    const result = beforeProviderRequest?.(
      {
        payload: {
          input: "hello",
          tools: [{ type: "function", name: "existing_tool" }],
        },
      },
      {
        model: { provider: "xai", id: "grok-4" },
      },
    );

    expect(result).toEqual({
      input: "hello",
      tools: [
        { type: "function", name: "existing_tool" },
        { type: "web_search" },
        { type: "x_search" },
      ],
    });
  });

  it("registers before_provider_request handling when xAI web search is disabled", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "xai",
        modelId: "grok-4",
        thinkingLevel: "high",
      },
      webSearch: false,
    });

    const extensionFactories = buildExtensionFactories(factory, descriptor);
    const handlers = new Map<string, (...args: any[]) => unknown>();

    for (const extensionFactory of extensionFactories) {
      extensionFactory({
        registerProvider: vi.fn(),
        on: (event: string, handler: (...args: any[]) => unknown) => {
          handlers.set(event, handler);
        },
      } as any);
    }

    expect(handlers.has("before_provider_request")).toBe(true);
  });
});
