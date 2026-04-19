import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPiModelsProjectionPath } from "../model-catalog-projection.js";

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
  authStorageCreate: vi.fn(() => ({})),
  authStorageInMemory: vi.fn((data: unknown) => ({ kind: "in-memory", data })),
  createAgentSession: vi.fn(),
  compact: vi.fn(),
  modelRegistryCreateArgs: vi.fn(),
  modelRegistryFind: vi.fn(),
  modelRegistryGetAll: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
}));

const claudeRuntimeMockState = vi.hoisted(() => ({
  constructorArgs: [] as unknown[],
  createMcpBridge: vi.fn(),
  constructImpl: undefined as ((options: unknown) => unknown) | undefined,
}));

const codexRuntimeMockState = vi.hoisted(() => ({
  create: vi.fn(),
}));

const acpRuntimeMockState = vi.hoisted(() => ({
  create: vi.fn(),
  createMcpBridge: vi.fn(),
}));

const sessionFileGuardMockState = vi.hoisted(() => ({
  openSessionManagerWithSizeGuard: vi.fn(() => ({})),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: (provider: unknown, modelId: unknown) => piAiMockState.getModel(provider, modelId),
  getModels: (provider: unknown) => piAiMockState.getModels(provider),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: (...args: unknown[]) => piCodingAgentMockState.authStorageCreate(...args),
    inMemory: (...args: unknown[]) => piCodingAgentMockState.authStorageInMemory(...args),
  },
  DefaultResourceLoader: class {
    readonly options: unknown

    constructor(options: unknown) {
      this.options = options
      piCodingAgentMockState.defaultResourceLoaderCtor(options)
    }

    async reload(): Promise<void> {}

    getPathMetadata(): Map<string, unknown> {
      return new Map();
    }
  },
  createAgentSession: (...args: unknown[]) => piCodingAgentMockState.createAgentSession(...args),
  compact: (...args: unknown[]) => piCodingAgentMockState.compact(...args),
  ModelRegistry: {
    create: (...args: unknown[]) => {
      piCodingAgentMockState.modelRegistryCreateArgs(...args)
      return {
        getError(): undefined {
          return undefined
        },

        find(provider: string, modelId: string): unknown {
          return piCodingAgentMockState.modelRegistryFind(provider, modelId)
        },

        getAll(): unknown[] {
          return piCodingAgentMockState.modelRegistryGetAll()
        },
      }
    },
  },
}));

vi.mock("../session-file-guard.js", () => ({
  openSessionManagerWithSizeGuard: (...args: unknown[]) => sessionFileGuardMockState.openSessionManagerWithSizeGuard(...args),
}));

vi.mock("../claude-mcp-tool-bridge.js", () => ({
  createClaudeMcpToolBridge: (...args: unknown[]) => claudeRuntimeMockState.createMcpBridge(...args),
}));

vi.mock("../claude-agent-runtime.js", () => ({
  ClaudeAgentRuntime: class {
    constructor(options: unknown) {
      claudeRuntimeMockState.constructorArgs.push(options)
      return claudeRuntimeMockState.constructImpl?.(options) as object | undefined
    }
  },
}));

vi.mock("../codex-agent-runtime.js", () => ({
  CodexAgentRuntime: {
    create: (...args: unknown[]) => codexRuntimeMockState.create(...args),
  },
}));

vi.mock("../acp-agent-runtime.js", () => ({
  AcpAgentRuntime: {
    create: (...args: unknown[]) => acpRuntimeMockState.create(...args),
  },
}));

vi.mock("../runtime/acp/acp-mcp-tool-bridge.js", () => ({
  createAcpMcpToolBridge: (...args: unknown[]) => acpRuntimeMockState.createMcpBridge(...args),
}));

vi.mock("../claude-prompt-assembler.js", () => ({
  assembleClaudePrompt: vi.fn(async ({ basePrompt }: { basePrompt: string }) => basePrompt),
  discoverAgentsMd: vi.fn(async () => []),
}));

vi.mock("../skill-metadata-service.js", () => ({
  SkillMetadataService: class {
    async ensureSkillMetadataLoaded(): Promise<void> {}

    getSkillMetadata(): unknown[] {
      return []
    }
  },
}));

vi.mock("../onboarding-state.js", () => ({
  getOnboardingSnapshot: vi.fn(async () => ({ status: "pending" })),
}));

import { ClaudeSdkUnavailableError, resetClaudeSdkLoaderForTests, setClaudeSdkImporterForTests } from "../claude-sdk-loader.js";
import { savePins } from "../message-pins.js";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import { RuntimeFactory } from "../runtime-factory.js";
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
      sharedIntegrationsDir: join(dataDir, "shared", "config", "integrations"),
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

function createManagerDescriptor(rootDir: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return createDescriptor(rootDir, {
    agentId: "manager-1",
    displayName: "Manager 1",
    role: "manager",
    managerId: "manager-1",
    sessionLabel: "Manager 1",
    sessionFile: join(rootDir, "manager-session.jsonl"),
    ...overrides,
  });
}

async function seedProjectionFile(rootDir: string): Promise<string> {
  const projectionPath = getPiModelsProjectionPath(join(rootDir, "data"));
  await mkdir(join(rootDir, "data", "shared", "cache", "generated"), { recursive: true });
  await writeFile(projectionPath, '{"providers":{}}\n', "utf8");
  return projectionPath;
}

function createFactory(
  rootDir: string,
  overrides: {
    logDebug?: (message: string, details?: unknown) => void;
    hostOverrides?: Record<string, unknown>;
    forgeExtensionHost?: ForgeExtensionHost;
    getAgentDescriptor?: (agentId: string) => AgentDescriptor | undefined;
    getCredentialPoolService?: () => any;
    buildAcpRuntimeSystemPrompt?: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
  } = {},
): RuntimeFactory {
  const host = {
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
    ...overrides.hostOverrides,
  };

  return new RuntimeFactory({
    host: host as any,
    forgeExtensionHost: overrides.forgeExtensionHost ?? new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    }),
    config: createConfig(rootDir),
    now: () => "2026-01-01T00:00:00.000Z",
    logDebug: overrides.logDebug ?? (() => {}),
    getPiModelsJsonPath: () => getPiModelsProjectionPath(join(rootDir, "data")),
    getAgentDescriptor: overrides.getAgentDescriptor,
    getCredentialPoolService: overrides.getCredentialPoolService,
    getMemoryRuntimeResources: async () => ({
      memoryContextFile: {
        path: join(rootDir, "memory.md"),
        content: "",
      },
      additionalSkillPaths: [],
    }),
    getSwarmContextFiles: async () => [],
    buildClaudeRuntimeSystemPrompt: async (_descriptor, systemPrompt) => systemPrompt,
    buildCodexRuntimeSystemPrompt: async (_descriptor, systemPrompt) => systemPrompt,
    buildAcpRuntimeSystemPrompt:
      overrides.buildAcpRuntimeSystemPrompt ?? (async (_descriptor, systemPrompt) => systemPrompt),
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

function createMockPiSession() {
  return {
    bindExtensions: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    sessionManager: {},
    systemPrompt: "system prompt",
  };
}

function createMockRuntime(options: {
  descriptor?: AgentDescriptor;
  runtimeType?: "pi" | "claude" | "codex" | "acp";
  systemPrompt?: string;
}) {
  return {
    descriptor: options.descriptor ?? ({} as AgentDescriptor),
    runtimeType: options.runtimeType,
    getStatus: () => options.descriptor?.status ?? "idle",
    getPendingCount: () => 0,
    getContextUsage: () => undefined,
    getSystemPrompt: () => options.systemPrompt,
    sendMessage: vi.fn(async () => ({
      targetAgentId: options.descriptor?.agentId ?? "worker-1",
      deliveryId: "delivery-1",
      acceptedMode: "prompt",
    })),
    compact: vi.fn(async () => undefined),
    smartCompact: vi.fn(async () => ({ completed: false })),
    stopInFlight: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    shutdownForReplacement: vi.fn(async () => undefined),
    recycle: vi.fn(async () => undefined),
    getCustomEntries: () => [],
    appendCustomEntry: () => "entry-1",
  };
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
    resetClaudeSdkLoaderForTests();
    piAiMockState.getModel.mockReset();
    piAiMockState.getModels.mockClear();
    piCodingAgentMockState.authStorageCreate.mockClear();
    piCodingAgentMockState.authStorageInMemory.mockClear();
    piCodingAgentMockState.createAgentSession.mockReset();
    piCodingAgentMockState.compact.mockReset();
    piCodingAgentMockState.modelRegistryCreateArgs.mockReset();
    piCodingAgentMockState.modelRegistryFind.mockReset();
    piCodingAgentMockState.modelRegistryGetAll.mockReset();
    piCodingAgentMockState.defaultResourceLoaderCtor.mockReset();
    claudeRuntimeMockState.constructorArgs = [];
    claudeRuntimeMockState.constructImpl = undefined;
    claudeRuntimeMockState.createMcpBridge.mockReset();
    claudeRuntimeMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-test",
      server: {},
      allowedTools: [],
    });
    codexRuntimeMockState.create.mockReset();
    acpRuntimeMockState.create.mockReset();
    acpRuntimeMockState.createMcpBridge.mockReset();
    acpRuntimeMockState.createMcpBridge.mockResolvedValue({
      mcpDescriptor: {
        type: "http",
        name: "forge-tools",
        url: "http://127.0.0.1:4321/mcp",
        headers: [],
      },
      shutdown: vi.fn(async () => undefined),
    });
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReset();
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReturnValue({});
  });

  it("surfaces Claude SDK installation guidance when the native runtime is unavailable", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    setClaudeSdkImporterForTests(
      vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" }))
    );
    claudeRuntimeMockState.constructImpl = () => {
      throw new ClaudeSdkUnavailableError('Claude backend requires "@anthropic-ai/claude-agent-sdk" to be installed.', {
        code: 'ERR_MODULE_NOT_FOUND',
      })
    }

    const factory = createFactory(rootDir);

    await expect(
      factory.createRuntimeForDescriptor(
        createDescriptor(rootDir, {
          model: {
            provider: "claude-sdk",
            modelId: "claude-opus-4-6",
            thinkingLevel: "high",
          },
        }),
        "system prompt"
      )
    ).rejects.toThrow(
      'Install the Claude Agent SDK or switch this agent to the Pi-proxied anthropic/claude-opus-4-6 variant.'
    );
  });

  it("adds create_session tool for capable project agents in manager runtime tools", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    const descriptor = createManagerDescriptor(rootDir, {
      projectAgent: {
        handle: "notes",
        whenToUse: "Draft notes",
        capabilities: ["create_session"],
      }
    });
    await writeFile(descriptor.sessionFile, "", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({ provider: "openai-codex", modelId: "gpt-5.4-mini" });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const sendMessage = vi.fn(async () => ({
      targetAgentId: "manager-1",
      deliveryId: "delivery-1",
      acceptedMode: "prompt",
    }));

    const factory = createFactory(rootDir, {
      hostOverrides: { sendMessage }
    });

    await factory.createRuntimeForDescriptor(descriptor, "Base system prompt", 1);
    const createdTools = piCodingAgentMockState.createAgentSession.mock.calls.at(-1)?.[0]?.customTools as
      | Array<{ name: string }>
      | undefined;

    const toolNames = (createdTools ?? []).map((tool) => tool.name);

    expect(toolNames).toContain("create_session");
    expect(toolNames).not.toContain("create_project_agent");
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

    expect(piCodingAgentMockState.modelRegistryCreateArgs).toHaveBeenCalledWith(
      expect.anything(),
      getPiModelsProjectionPath(join(rootDir, "data")),
    );
    expect(piCodingAgentMockState.modelRegistryGetAll).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("fails fast when the generated Pi projection file is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt")).rejects.toThrow(
      `Pi model projection file is missing: ${getPiModelsProjectionPath(join(rootDir, "data"))}. Regenerate it before creating a ModelRegistry.`,
    );

    expect(piCodingAgentMockState.modelRegistryCreateArgs).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("selects pooled Anthropic credentials for Pi runtimes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const pool = {
      getPoolSize: vi.fn().mockResolvedValue(2),
      select: vi.fn().mockResolvedValue({
        credentialId: "cred_anthropic_second",
        authStorageKey: "anthropic:cred_anthropic_second",
      }),
      getEarliestCooldownExpiry: vi.fn(),
      buildRuntimeAuthData: vi.fn().mockResolvedValue({
        anthropic: { type: "oauth", access: "anthropic-token" },
        "openai-codex": { type: "oauth", access: "openai-token" },
      }),
      markUsed: vi.fn().mockResolvedValue(undefined),
    }

    const factory = createFactory(rootDir, {
      getCredentialPoolService: () => pool as any,
    })

    const selection = await (factory as unknown as {
      selectPooledCredential: (descriptor: AgentDescriptor) => Promise<unknown>
    }).selectPooledCredential(
      createDescriptor(rootDir, {
        model: {
          provider: "anthropic",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
        },
      }),
    )

    expect(pool.getPoolSize).toHaveBeenCalledWith("anthropic")
    expect(pool.select).toHaveBeenCalledWith("anthropic")
    expect(pool.buildRuntimeAuthData).toHaveBeenCalledWith("anthropic", "cred_anthropic_second")
    expect(pool.markUsed).toHaveBeenCalledWith("anthropic", "cred_anthropic_second")
    expect(piCodingAgentMockState.authStorageInMemory).toHaveBeenCalledWith({
      anthropic: { type: "oauth", access: "anthropic-token" },
      "openai-codex": { type: "oauth", access: "openai-token" },
    })
    expect(selection).toEqual({
      authStorage: {
        kind: "in-memory",
        data: {
          anthropic: { type: "oauth", access: "anthropic-token" },
          "openai-codex": { type: "oauth", access: "openai-token" },
        },
      },
      credentialId: "cred_anthropic_second",
    })
  })

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

  it("reloads Forge extension behavior on Pi runtime recreation boundaries", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    const extensionPath = join(rootDir, "data", "extensions", "rewrite.ts");
    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(
      extensionPath,
      'export default (forge) => { forge.on("tool:before", (event) => event.toolName === "send_message_to_agent" ? ({ input: { ...event.input, targetAgentId: "worker-first" } }) : undefined) }\n',
      "utf8"
    );

    const descriptor = createDescriptor(rootDir);
    await writeFile(descriptor.sessionFile, "", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({ provider: "openai-codex", modelId: "gpt-5.4-mini" });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const sendMessage = vi.fn(async (_sourceAgentId: string, targetAgentId: string) => ({
      targetAgentId,
      deliveryId: `delivery-${targetAgentId}`,
      acceptedMode: "prompt",
    }));
    const factory = createFactory(rootDir, {
      hostOverrides: {
        sendMessage,
      },
    });

    await factory.createRuntimeForDescriptor(descriptor, "system prompt", 1);
    const firstTools = piCodingAgentMockState.createAgentSession.mock.calls.at(-1)?.[0]?.customTools as Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    const firstSendTool = firstTools.find((tool) => tool.name === "send_message_to_agent");
    await firstSendTool?.execute("tool-1", { targetAgentId: "worker-original", message: "hello" });

    await writeFile(
      extensionPath,
      'export default (forge) => { forge.on("tool:before", (event) => event.toolName === "send_message_to_agent" ? ({ input: { ...event.input, targetAgentId: "worker-second" } }) : undefined) }\n',
      "utf8"
    );

    await factory.createRuntimeForDescriptor(descriptor, "system prompt", 2);
    const secondTools = piCodingAgentMockState.createAgentSession.mock.calls.at(-1)?.[0]?.customTools as Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    const secondSendTool = secondTools.find((tool) => tool.name === "send_message_to_agent");
    await secondSendTool?.execute("tool-2", { targetAgentId: "worker-original", message: "hello" });

    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual(["worker-first", "worker-second"]);
  });

  it("passes worker runtime context with worker agent data and owning manager session data on Pi runtimes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(
      join(rootDir, "data", "extensions", "context.ts"),
      'export default (forge) => { forge.on("tool:before", (event, ctx) => event.toolName === "send_message_to_agent" ? ({ input: { ...event.input, targetAgentId: ctx.agent.agentId, message: JSON.stringify({ sessionAgentId: ctx.session.sessionAgentId, sessionLabel: ctx.session.label, sessionCwd: ctx.session.cwd, agentCwd: ctx.agent.cwd }) } }) : undefined) }\n',
      "utf8"
    );

    const managerCwd = join(rootDir, "manager-cwd");
    const workerCwd = join(rootDir, "worker-cwd");
    await mkdir(managerCwd, { recursive: true });
    await mkdir(workerCwd, { recursive: true });

    const descriptor = createDescriptor(rootDir, { cwd: workerCwd });
    const managerDescriptor = createManagerDescriptor(rootDir, {
      cwd: managerCwd,
      sessionLabel: "Manager Session",
      profileId: "profile-1",
    });
    await writeFile(descriptor.sessionFile, "", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({ provider: "openai-codex", modelId: "gpt-5.4-mini" });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const sendMessage = vi.fn(async (_sourceAgentId: string, targetAgentId: string, message: string) => ({
      targetAgentId,
      deliveryId: "delivery-1",
      acceptedMode: "prompt",
      message,
    }));
    const factory = createFactory(rootDir, {
      hostOverrides: {
        sendMessage,
      },
      getAgentDescriptor: (agentId) => (agentId === managerDescriptor.agentId ? managerDescriptor : undefined),
    });

    await factory.createRuntimeForDescriptor(descriptor, "system prompt", 1);
    const tools = piCodingAgentMockState.createAgentSession.mock.calls.at(-1)?.[0]?.customTools as Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    const sendTool = tools.find((tool) => tool.name === "send_message_to_agent");
    await sendTool?.execute("tool-context", { targetAgentId: "worker-original", message: "ignored" });

    expect(sendMessage).toHaveBeenCalledWith(
      "worker-1",
      "worker-1",
      JSON.stringify({
        sessionAgentId: "manager-1",
        sessionLabel: "Manager Session",
        sessionCwd: managerCwd,
        agentCwd: workerCwd,
      }),
      undefined
    );
  });

  it("does not leave active Forge runtime snapshots behind when Pi runtime creation fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(join(rootDir, "data", "extensions", "hooks.ts"), 'export default () => {}\n', "utf8");

    const descriptor = createDescriptor(rootDir);
    await writeFile(descriptor.sessionFile, "", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({ provider: "openai-codex", modelId: "gpt-5.4-mini" });
    piCodingAgentMockState.createAgentSession.mockRejectedValue(new Error("createAgentSession failed"));

    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const factory = createFactory(rootDir, { forgeExtensionHost });

    await expect(factory.createRuntimeForDescriptor(descriptor, "system prompt", 1)).rejects.toThrow(
      "createAgentSession failed"
    );

    const snapshot = await forgeExtensionHost.buildSettingsSnapshot({ cwdValues: [rootDir] });
    expect(snapshot.snapshots).toEqual([]);
  });

  it("injects startup-only recovery context into Pi manager runtime creation without changing the stored base prompt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    const descriptor = createManagerDescriptor(rootDir);
    await writeFile(descriptor.sessionFile, "", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({ provider: "openai-codex", modelId: "gpt-5.4-mini" });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const factory = createFactory(rootDir);
    const runtime = await factory.createRuntimeForDescriptor(descriptor, "Base system prompt", 1, {
      startupRecoveryContext: {
        reason: "model_change",
        blockText: "# Recovered Forge Conversation Context\nRecovered history"
      }
    });

    const resourceLoaderOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      systemPrompt: string;
      agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
        agentsFiles: Array<{ path: string; content: string }>;
      };
    };
    const agentsFiles = resourceLoaderOptions.agentsFilesOverride({ agentsFiles: [] }).agentsFiles;

    expect(resourceLoaderOptions.systemPrompt).toBe("Base system prompt");
    expect(agentsFiles).toContainEqual({
      path: join(rootDir, ".forge", "ephemeral-model-change-recovery.md"),
      content: "# Recovered Forge Conversation Context\nRecovered history"
    });
    expect(runtime.getSystemPrompt?.()).toBe("Base system prompt");
  });

  it("passes startup-only recovery overrides to Claude and Codex runtimes while preserving the base prompt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    claudeRuntimeMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-test",
      server: {},
      allowedTools: [],
    });
    codexRuntimeMockState.create.mockResolvedValue({} as any);

    const factory = createFactory(rootDir);
    const startupRecoveryContext = {
      reason: "model_change" as const,
      blockText: "# Recovered Forge Conversation Context\nRecovered history"
    };

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "claude-sdk",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
        },
      }),
      "Base Claude prompt",
      1,
      { startupRecoveryContext }
    );

    const claudeOptions = claudeRuntimeMockState.constructorArgs.at(-1) as {
      systemPrompt: string;
      startupSystemPromptOverride?: string;
      skipInitialSessionResume?: boolean;
    };
    expect(claudeOptions.systemPrompt).toBe("Base Claude prompt");
    expect(claudeOptions.startupSystemPromptOverride).toContain("# Recovered Forge Conversation Context");
    expect(claudeOptions.skipInitialSessionResume).toBe(true);

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "openai-codex-app-server",
          modelId: "gpt-5-codex",
          thinkingLevel: "high",
        },
      }),
      "Base Codex prompt",
      2,
      { startupRecoveryContext }
    );

    const codexOptions = codexRuntimeMockState.create.mock.calls.at(-1)?.[0] as {
      systemPrompt: string;
      startupSystemPromptOverride?: string;
      skipInitialThreadResume?: boolean;
    };
    expect(codexOptions.systemPrompt).toBe("Base Codex prompt");
    expect(codexOptions.startupSystemPromptOverride).toContain("# Recovered Forge Conversation Context");
    expect(codexOptions.skipInitialThreadResume).toBe(true);
  });

  it("selects the ACP runtime and invokes the ACP prompt builder for cursor-acp providers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const buildAcpRuntimeSystemPrompt = vi.fn(async (_descriptor: AgentDescriptor, systemPrompt: string) => `${systemPrompt}\n\nACP prompt`);
    acpRuntimeMockState.create.mockImplementation(async (options: { descriptor: AgentDescriptor; systemPrompt: string }) =>
      createMockRuntime({
        descriptor: options.descriptor,
        runtimeType: "acp",
        systemPrompt: options.systemPrompt,
      })
    );

    const factory = createFactory(rootDir, {
      buildAcpRuntimeSystemPrompt,
    });

    const runtime = await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "cursor-acp",
          modelId: "default",
          thinkingLevel: "high",
        },
      }),
      "Base ACP prompt",
      3
    );

    expect(acpRuntimeMockState.create).toHaveBeenCalledTimes(1);
    expect(buildAcpRuntimeSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker-1" }),
      "Base ACP prompt"
    );
    expect(runtime.runtimeType).toBe("acp");
    expect(claudeRuntimeMockState.constructorArgs).toHaveLength(0);
    expect(codexRuntimeMockState.create).not.toHaveBeenCalled();

    const acpOptions = acpRuntimeMockState.create.mock.calls.at(-1)?.[0] as {
      systemPrompt: string;
      mcpServers: Array<{ type: string; name: string; url: string }>;
    };
    expect(acpOptions.systemPrompt).toBe("Base ACP prompt\n\nACP prompt");
    expect(acpOptions.mcpServers).toEqual([
      {
        type: "http",
        name: "forge-tools",
        url: "http://127.0.0.1:4321/mcp",
        headers: [],
      },
    ]);
  });

  it("shuts down the ACP MCP bridge when prompt assembly fails before runtime creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const shutdown = vi.fn(async () => undefined);
    acpRuntimeMockState.createMcpBridge.mockResolvedValue({
      mcpDescriptor: {
        type: "http",
        name: "forge-tools",
        url: "http://127.0.0.1:4321/mcp",
        headers: [],
      },
      shutdown,
    });

    const buildAcpRuntimeSystemPrompt = vi.fn(async () => {
      throw new Error("acp prompt failed");
    });

    const factory = createFactory(rootDir, {
      buildAcpRuntimeSystemPrompt,
    });

    await expect(
      factory.createRuntimeForDescriptor(
        createDescriptor(rootDir, {
          model: {
            provider: "cursor-acp",
            modelId: "default",
            thinkingLevel: "high",
          },
        }),
        "Base ACP prompt",
        8
      )
    ).rejects.toThrow("acp prompt failed");

    expect(acpRuntimeMockState.createMcpBridge).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(acpRuntimeMockState.create).not.toHaveBeenCalled();
  });

  it("prepares ACP Forge extension bindings with runtimeType acp", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(join(rootDir, "data", "extensions", "noop.ts"), "export default () => {}\n", "utf8");

    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const prepareSpy = vi.spyOn(forgeExtensionHost, "prepareRuntimeBindings");
    const activateSpy = vi.spyOn(forgeExtensionHost, "activateRuntimeBindings");

    acpRuntimeMockState.create.mockImplementation(async (options: { descriptor: AgentDescriptor; systemPrompt: string }) =>
      createMockRuntime({
        descriptor: options.descriptor,
        runtimeType: "acp",
        systemPrompt: options.systemPrompt,
      })
    );

    const factory = createFactory(rootDir, { forgeExtensionHost });
    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "cursor-acp",
          modelId: "default",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      7
    );

    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "acp",
        runtimeToken: 7,
      })
    );
    expect(activateSpy).toHaveBeenCalled();
    expect((activateSpy.mock.calls.at(-1)?.[0] as { runtimeType: string }).runtimeType).toBe("acp");
  });

  it("does not inject a Pi recovery file when the startup recovery block is empty", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    const descriptor = createManagerDescriptor(rootDir);
    await writeFile(descriptor.sessionFile, "", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({ provider: "openai-codex", modelId: "gpt-5.4-mini" });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const factory = createFactory(rootDir);
    await factory.createRuntimeForDescriptor(descriptor, "Base system prompt", 1, {
      startupRecoveryContext: {
        reason: "model_change",
        blockText: ""
      }
    });

    const resourceLoaderOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
        agentsFiles: Array<{ path: string; content: string }>;
      };
    };
    const agentsFiles = resourceLoaderOptions.agentsFilesOverride({ agentsFiles: [] }).agentsFiles;

    expect(agentsFiles).not.toContainEqual(
      expect.objectContaining({ path: join(rootDir, ".forge", "ephemeral-model-change-recovery.md") })
    );
  });

  it("wraps Forge-owned tools for Claude, Codex, and ACP runtimes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(
      join(rootDir, "data", "extensions", "rewrite.ts"),
      'export default (forge) => { forge.on("tool:before", (event) => event.toolName === "send_message_to_agent" ? ({ input: { ...event.input, targetAgentId: "worker-rewritten" } }) : undefined) }\n',
      "utf8"
    );

    const sendMessage = vi.fn(async (_sourceAgentId: string, targetAgentId: string) => ({
      targetAgentId,
      deliveryId: "delivery-1",
      acceptedMode: "prompt",
    }));
    const factory = createFactory(rootDir, {
      hostOverrides: {
        sendMessage,
      },
    });

    claudeRuntimeMockState.createMcpBridge.mockImplementation(async (tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>) => ({
      serverName: "forge-test",
      server: {},
      allowedTools: tools.map((tool) => tool.name),
      tools,
    }));
    codexRuntimeMockState.create.mockImplementation(async (options: { tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }> }) => options as unknown);
    acpRuntimeMockState.createMcpBridge.mockImplementation(async (tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>) => ({
      mcpDescriptor: {
        type: "http",
        name: "forge-tools",
        url: "http://127.0.0.1:4321/mcp",
        headers: [],
      },
      shutdown: vi.fn(async () => undefined),
      tools,
    }));
    acpRuntimeMockState.create.mockImplementation(async (options: { descriptor: AgentDescriptor; systemPrompt: string }) =>
      createMockRuntime({
        descriptor: options.descriptor,
        runtimeType: "acp",
        systemPrompt: options.systemPrompt,
      })
    );

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "claude-sdk",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      1
    );
    const claudeTools = claudeRuntimeMockState.createMcpBridge.mock.calls.at(-1)?.[0] as Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    await claudeTools.find((tool) => tool.name === "send_message_to_agent")?.execute("tool-claude", {
      targetAgentId: "worker-original",
      message: "hello",
    });

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "openai-codex-app-server",
          modelId: "gpt-5-codex",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      2
    );
    const codexOptions = codexRuntimeMockState.create.mock.calls.at(-1)?.[0] as { tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }> };
    await codexOptions.tools.find((tool) => tool.name === "send_message_to_agent")?.execute("tool-codex", {
      targetAgentId: "worker-original",
      message: "hello",
    });

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "cursor-acp",
          modelId: "default",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      3
    );
    const acpTools = acpRuntimeMockState.createMcpBridge.mock.calls.at(-1)?.[0] as Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    await acpTools.find((tool) => tool.name === "send_message_to_agent")?.execute("tool-acp", {
      targetAgentId: "worker-original",
      message: "hello",
    });

    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      "worker-rewritten",
      "worker-rewritten",
      "worker-rewritten",
    ]);
  });
});
