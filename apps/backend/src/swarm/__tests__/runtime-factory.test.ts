import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPiModelsProjectionPath } from "../model-catalog-projection.js";
import { planPiExtensionFactories } from "../runtime/runtime-tool-plan.js";

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
  defaultResourceLoaderReload: vi.fn(async () => undefined),
  settingsManagerCreate: vi.fn(),
  settingsManagerFromStorage: vi.fn(),
  settingsManagerApplyOverrides: vi.fn(),
}));

const claudeRuntimeMockState = vi.hoisted(() => ({
  constructorArgs: [] as unknown[],
  createMcpBridge: vi.fn(),
  constructImpl: undefined as ((options: unknown) => unknown) | undefined,
}));

const acpRuntimeMockState = vi.hoisted(() => ({
  create: vi.fn(),
  createMcpBridge: vi.fn(),
}));

const cursorMcpMockState = vi.hoisted(() => ({
  createMcpBridge: vi.fn(async () => ({
    serverName: "forge-swarm-worker-1",
    mcpServers: { "forge-swarm-worker-1": { type: "http", url: "http://127.0.0.1:1/mcp" } },
    shutdown: vi.fn(async () => undefined),
  })),
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

    async reload(): Promise<void> {
      await piCodingAgentMockState.defaultResourceLoaderReload()
    }

    getPathMetadata(): Map<string, unknown> {
      return new Map();
    }
  },
  createAgentSession: (...args: unknown[]) => piCodingAgentMockState.createAgentSession(...args),
  compact: (...args: unknown[]) => piCodingAgentMockState.compact(...args),
  SettingsManager: {
    create: (...args: unknown[]) => {
      piCodingAgentMockState.settingsManagerCreate(...args)
      return {
        applyOverrides: (...overrideArgs: unknown[]) => piCodingAgentMockState.settingsManagerApplyOverrides(...overrideArgs),
      }
    },
    fromStorage: (...args: unknown[]) => {
      piCodingAgentMockState.settingsManagerFromStorage(...args)
      return {
        applyOverrides: (...overrideArgs: unknown[]) => piCodingAgentMockState.settingsManagerApplyOverrides(...overrideArgs),
      }
    },
  },
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

vi.mock("../acp-agent-runtime.js", () => ({
  AcpAgentRuntime: {
    create: (...args: unknown[]) => acpRuntimeMockState.create(...args),
  },
}));

vi.mock("../runtime/acp/acp-mcp-tool-bridge.js", () => ({
  createAcpMcpToolBridge: (...args: unknown[]) => acpRuntimeMockState.createMcpBridge(...args),
}));

vi.mock("../runtime/cursor-sdk/cursor-sdk-mcp-tool-bridge.js", () => ({
  createCursorSdkMcpToolBridge: (...args: unknown[]) => cursorMcpMockState.createMcpBridge(...args),
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
import { modelCatalogService } from "../model-catalog-service.js";
import { savePins } from "../message-pins.js";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import { RuntimeFactory } from "../runtime-factory.js";
import { resetCursorSdkLoaderForTests, setCursorSdkImporterForTests } from "../runtime/cursor-sdk/cursor-sdk-loader.js";
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
    getMemoryRuntimeResources?: (descriptor: AgentDescriptor) => Promise<{
      memoryContextFile: { path: string; content: string };
      additionalSkillPaths: string[];
      skillMetadata: SkillMetadata[];
    }>;
    buildAcpRuntimeSystemPrompt?: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
    buildCursorSdkRuntimeSystemPrompt?: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
    callbacks?: Partial<{
      onRuntimeError: (runtimeToken: number, agentId: string, error: unknown) => Promise<void>;
      onRuntimeExtensionSnapshot: (runtimeToken: number, agentId: string, snapshot: unknown) => Promise<void>;
    }>;
    skipProjectionBootstrap?: boolean;
  } = {},
): RuntimeFactory {
  const projectionPath = getPiModelsProjectionPath(join(rootDir, "data"));
  if (!overrides.skipProjectionBootstrap) {
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, "{}", "utf8");
  }

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
    getPiModelsJsonPath: () => projectionPath,
    getAgentDescriptor: overrides.getAgentDescriptor,
    getCredentialPoolService: overrides.getCredentialPoolService,
    getMemoryRuntimeResources: overrides.getMemoryRuntimeResources ?? (async () => ({
      memoryContextFile: {
        path: join(rootDir, "memory.md"),
        content: "",
      },
      additionalSkillPaths: [],
      skillMetadata: [],
    })),
    getSwarmContextFiles: async () => [],
    buildClaudeRuntimeSystemPrompt: async (_descriptor, systemPrompt) => systemPrompt,
    buildAcpRuntimeSystemPrompt:
      overrides.buildAcpRuntimeSystemPrompt ?? (async (_descriptor, systemPrompt) => systemPrompt),
    buildCursorSdkRuntimeSystemPrompt:
      overrides.buildCursorSdkRuntimeSystemPrompt ?? (async (_descriptor, systemPrompt) => systemPrompt),
    mergeRuntimeContextFiles: (base) => base,
    callbacks: {
      onStatusChange: async () => {},
      onSessionEvent: async () => {},
      onAgentEnd: async () => {},
      onRuntimeError: overrides.callbacks?.onRuntimeError ?? (async () => {}),
      onRuntimeExtensionSnapshot: overrides.callbacks?.onRuntimeExtensionSnapshot ?? (async () => {}),
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
  runtimeType?: "pi" | "claude" | "acp";
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

function buildExtensionFactories(rootDir: string, descriptor: AgentDescriptor) {
  return planPiExtensionFactories({
    descriptor,
    config: createConfig(rootDir),
    logDebug: () => {},
  });
}

function fakeSkillMetadata(directoryName: string, rootPath: string, skillName = directoryName) {
  return {
    skillId: directoryName,
    skillName,
    directoryName,
    path: join(rootPath, "SKILL.md"),
    rootPath,
    env: [],
    sourceKind: "machine-local" as const,
    isInherited: false,
    isEffective: true,
  };
}

function fakePiSkill(name: string, filePath: string, baseDir: string) {
  return {
    name,
    description: name,
    filePath,
    baseDir,
    sourceInfo: {},
    disableModelInvocation: false,
  };
}

function setupPiModel(provider = "openai-codex", modelId = "gpt-5.4-mini") {
  piCodingAgentMockState.modelRegistryFind.mockReturnValue({
    id: modelId,
    name: modelId,
    api: provider === "openai-codex" ? "openai-codex-responses" : "anthropic-messages",
    provider,
    baseUrl: `https://example.test/${provider}`,
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  });
}

const providerRuntimeCases = [
  {
    runtimeName: "Claude SDK",
    model: {
      provider: "claude-sdk",
      modelId: "claude-opus-4-6",
      thinkingLevel: "high",
    },
    setupRuntimeMock: () => undefined,
    getBridgeToolNames: () => {
      const tools = claudeRuntimeMockState.createMcpBridge.mock.calls.at(-1)?.[0] as Array<{ name: string }> | undefined;
      return (tools ?? []).map((tool) => tool.name);
    },
  },
  {
    runtimeName: "ACP",
    model: {
      provider: "cursor-acp",
      modelId: "default",
      thinkingLevel: "high",
    },
    setupRuntimeMock: () => {
      acpRuntimeMockState.create.mockImplementation(async (options: { descriptor: AgentDescriptor; systemPrompt: string }) =>
        createMockRuntime({
          descriptor: options.descriptor,
          runtimeType: "acp",
          systemPrompt: options.systemPrompt,
        })
      );
    },
    getBridgeToolNames: () => {
      const tools = acpRuntimeMockState.createMcpBridge.mock.calls.at(-1)?.[0] as Array<{ name: string }> | undefined;
      return (tools ?? []).map((tool) => tool.name);
    },
  },
] satisfies Array<{
  runtimeName: string;
  model: AgentDescriptor["model"];
  setupRuntimeMock: () => void;
  getBridgeToolNames: () => string[];
}>;

describe("RuntimeFactory", () => {
  beforeEach(() => {
    resetClaudeSdkLoaderForTests();
    resetCursorSdkLoaderForTests();
    delete process.env.CURSOR_API_KEY;
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
    piCodingAgentMockState.defaultResourceLoaderReload.mockReset();
    piCodingAgentMockState.defaultResourceLoaderReload.mockResolvedValue(undefined);
    piCodingAgentMockState.settingsManagerCreate.mockReset();
    piCodingAgentMockState.settingsManagerFromStorage.mockReset();
    piCodingAgentMockState.settingsManagerApplyOverrides.mockReset();
    delete process.env.FORGE_OPENAI_CODEX_TRANSPORT;
    claudeRuntimeMockState.constructorArgs = [];
    claudeRuntimeMockState.constructImpl = undefined;
    claudeRuntimeMockState.createMcpBridge.mockReset();
    claudeRuntimeMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-test",
      server: {},
      allowedTools: [],
    });
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
    cursorMcpMockState.createMcpBridge.mockReset();
    cursorMcpMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-swarm-worker-1",
      mcpServers: { "forge-swarm-worker-1": { type: "http", url: "http://127.0.0.1:1/mcp" } },
      shutdown: vi.fn(async () => undefined),
    });
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReset();
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReturnValue({});
  });

  it("strictly filters Pi runtime skills for collaboration descriptors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "data", "profiles", "profile-1", "pi", "skills", "profile-skill"), { recursive: true });
    await writeFile(join(rootDir, "data", "profiles", "profile-1", "pi", "skills", "profile-skill", "SKILL.md"), "# profile", "utf8");

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const memorySkill = fakeSkillMetadata("memory", join(rootDir, "global", "memory"));
    const searchSkill = fakeSkillMetadata("brave-search", join(rootDir, "global", "brave-search"));
    const customSkill = fakeSkillMetadata("stable-custom-handle", join(rootDir, "global", "stable-custom-handle"), "Mutable Display Name");
    const manager = createManagerDescriptor(rootDir, { sessionSurface: "collab" });
    const factory = createFactory(rootDir, {
      getAgentDescriptor: (agentId) => agentId === manager.agentId ? manager : undefined,
      getMemoryRuntimeResources: async () => ({
        memoryContextFile: { path: join(rootDir, "memory.md"), content: "" },
        additionalSkillPaths: [memorySkill.path, searchSkill.path, customSkill.path],
        skillMetadata: [memorySkill, searchSkill, customSkill],
      }),
    });

    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt");

    const loaderOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      additionalSkillPaths: string[];
      skillsOverride?: (current: { skills: unknown[]; diagnostics: unknown[] }) => { skills: unknown[]; diagnostics: unknown[] };
    };
    expect(loaderOptions.additionalSkillPaths).toEqual([memorySkill.path, searchSkill.path, customSkill.path]);
    expect(loaderOptions.additionalSkillPaths).not.toContain(join(rootDir, "data", "profiles", "profile-1", "pi", "skills"));
    expect(loaderOptions.skillsOverride).toEqual(expect.any(Function));

    const bypassSkillPath = join(rootDir, ".pi", "skills", "brave-search", "SKILL.md");
    const unselectedSkillPath = join(rootDir, "global", "not-selected-bypass", "SKILL.md");
    const overrideResult = loaderOptions.skillsOverride!({
      diagnostics: [],
      skills: [
        fakePiSkill("memory", memorySkill.path, memorySkill.rootPath),
        fakePiSkill("brave-search", searchSkill.path, searchSkill.rootPath),
        fakePiSkill("Mutable Display Name", customSkill.path, customSkill.rootPath),
        fakePiSkill("brave-search", bypassSkillPath, dirname(bypassSkillPath)),
        fakePiSkill("Not Selected Display", unselectedSkillPath, dirname(unselectedSkillPath)),
        fakePiSkill("profile-skill", join(rootDir, "data", "profiles", "profile-1", "pi", "skills", "profile-skill", "SKILL.md"), join(rootDir, "data", "profiles", "profile-1", "pi", "skills", "profile-skill")),
      ],
    });
    expect(overrideResult.skills).toEqual([
      expect.objectContaining({ name: "memory" }),
      expect.objectContaining({ name: "brave-search", filePath: searchSkill.path }),
      expect.objectContaining({ name: "Mutable Display Name", filePath: customSkill.path }),
    ]);
  });

  it("uses effective Builder Pi profile skill paths without broad profile directory discovery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const profileSkillRoot = join(rootDir, "data", "profiles", "profile-1", "pi", "skills", "profile-skill");
    const profileSkillPath = join(profileSkillRoot, "SKILL.md");
    await mkdir(profileSkillRoot, { recursive: true });
    await writeFile(profileSkillPath, "# profile", "utf8");
    piCodingAgentMockState.modelRegistryFind.mockReturnValue({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });
    const factory = createFactory(rootDir, {
      getMemoryRuntimeResources: async () => ({
        memoryContextFile: { path: join(rootDir, "memory.md"), content: "" },
        additionalSkillPaths: [profileSkillPath],
        skillMetadata: [fakeSkillMetadata("profile-skill", profileSkillRoot)],
      }),
    });

    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt");

    const loaderOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      additionalSkillPaths: string[];
      skillsOverride?: unknown;
    };
    expect(loaderOptions.additionalSkillPaths).toEqual([profileSkillPath]);
    expect(loaderOptions.additionalSkillPaths).not.toContain(join(rootDir, "data", "profiles", "profile-1", "pi", "skills"));
    expect(loaderOptions.skillsOverride).toBeUndefined();
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

  it.each(providerRuntimeCases)(
    "passes Agent Creator tools through the $runtimeName MCP bridge provider path",
    async ({ model, setupRuntimeMock, getBridgeToolNames }) => {
      const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
      await mkdir(rootDir, { recursive: true });
      setupRuntimeMock();

      const descriptor = createManagerDescriptor(rootDir, {
        model,
        sessionPurpose: "agent_creator",
      });
      const factory = createFactory(rootDir);

      await factory.createRuntimeForDescriptor(descriptor, "Base system prompt", 1);

      const toolNames = getBridgeToolNames();
      expect(toolNames).toContain("create_project_agent");
      expect(toolNames).toContain("speak_to_user");
    }
  );

  it.each(providerRuntimeCases)(
    "passes Cortex-filtered tools through the $runtimeName MCP bridge provider path",
    async ({ model, setupRuntimeMock, getBridgeToolNames }) => {
      const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
      await mkdir(rootDir, { recursive: true });
      setupRuntimeMock();

      const descriptor = createManagerDescriptor(rootDir, {
        model,
        archetypeId: "cortex",
      });
      const factory = createFactory(rootDir);

      await factory.createRuntimeForDescriptor(descriptor, "Base system prompt", 1);

      const toolNames = getBridgeToolNames();
      expect(toolNames).toContain("spawn_agent");
      expect(toolNames).not.toContain("list_agents");
      expect(toolNames).not.toContain("kill_agent");
    }
  );

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

  it("synthesizes catalog-backed GPT-5.5 models when the bundled Pi registry is behind", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    await seedProjectionFile(rootDir);

    piCodingAgentMockState.modelRegistryFind.mockReturnValue(undefined);
    piAiMockState.getModel.mockImplementation((provider: unknown, modelId: unknown) => {
      if (provider === "openai-codex" && modelId === "gpt-5.4") {
        return {
          id: "gpt-5.4",
          name: "GPT-5.4",
          api: "openai-codex-responses",
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
          contextWindow: 272_000,
          maxTokens: 128_000,
        };
      }

      return undefined;
    });
    piAiMockState.getModels.mockImplementation((provider: unknown) =>
      provider === "openai-codex"
        ? [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              api: "openai-codex-responses",
              provider: "openai-codex",
              baseUrl: "https://chatgpt.com/backend-api",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
              contextWindow: 272_000,
              maxTokens: 128_000,
            },
          ]
        : [],
    );
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const factory = createFactory(rootDir);

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "openai-codex",
          modelId: "gpt-5.5",
          thinkingLevel: "xhigh",
        },
      }),
      "system prompt",
    );

    expect(piCodingAgentMockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          contextWindow: 272_000,
          maxTokens: 128_000,
        }),
      }),
    );
  });

  it.each(["sse", "websocket", "websocket-cached", "auto"] as const)(
    "applies explicit OpenAI Codex transport override %s from the environment",
    async (transport) => {
      const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
      await mkdir(rootDir, { recursive: true });
      await seedProjectionFile(rootDir);

      piCodingAgentMockState.modelRegistryFind.mockReturnValue({
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
      });
      piCodingAgentMockState.createAgentSession.mockResolvedValue({
        session: createMockPiSession(),
        extensionsResult: { extensions: [], errors: [] },
      });
      process.env.FORGE_OPENAI_CODEX_TRANSPORT = transport;

      const factory = createFactory(rootDir);
      await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt");

      expect(piCodingAgentMockState.settingsManagerFromStorage).toHaveBeenCalledWith(
        expect.objectContaining({ withLock: expect.any(Function) }),
      );
      expect(piCodingAgentMockState.settingsManagerApplyOverrides).toHaveBeenCalledWith({
        transport,
      });
      expect(piCodingAgentMockState.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          settingsManager: expect.any(Object),
        }),
      );
    },
  );

  it("keeps non-Codex Pi runtimes from applying Codex transport overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({
      id: "grok-4",
      name: "Grok 4",
      api: "openai-responses",
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });
    process.env.FORGE_OPENAI_CODEX_TRANSPORT = "websocket-cached";

    const factory = createFactory(rootDir);
    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: { provider: "xai", modelId: "grok-4", thinkingLevel: "high" },
      }),
      "system prompt",
    );

    expect(piCodingAgentMockState.settingsManagerFromStorage).toHaveBeenCalledWith(
      expect.objectContaining({ withLock: expect.any(Function) }),
    );
    expect(piCodingAgentMockState.settingsManagerApplyOverrides).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: expect.any(Object) }),
    );
  });

  it.each([
    [undefined, "unset"],
    ["", "blank"],
    ["invalid-transport", "invalid"],
  ])("defaults OpenAI Codex transport to sse when env is %s", async (transportEnv) => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    piCodingAgentMockState.modelRegistryFind.mockReturnValue({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 1000,
    });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });
    if (transportEnv !== undefined) {
      process.env.FORGE_OPENAI_CODEX_TRANSPORT = transportEnv;
    }

    const factory = createFactory(rootDir);
    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt");

    expect(piCodingAgentMockState.settingsManagerApplyOverrides).toHaveBeenCalledWith({ transport: "sse" });
  });

  it("fails fast when the generated Pi projection file is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const factory = createFactory(rootDir, { skipProjectionBootstrap: true });

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt")).rejects.toThrow(
      `Pi model projection file is missing: ${getPiModelsProjectionPath(join(rootDir, "data"))}. Regenerate it before creating a ModelRegistry.`,
    );

    expect(piCodingAgentMockState.modelRegistryCreateArgs).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("selects pooled Anthropic credentials through black-box Pi runtime creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await seedProjectionFile(rootDir);

    setupPiModel("anthropic", "claude-opus-4-6");
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

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
    };

    const factory = createFactory(rootDir, {
      getCredentialPoolService: () => pool as any,
    });
    const runtime = await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "anthropic",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
    );

    expect(pool.getPoolSize).toHaveBeenCalledWith("anthropic");
    expect(pool.select).toHaveBeenCalledWith("anthropic");
    expect(pool.buildRuntimeAuthData).toHaveBeenCalledWith("anthropic", "cred_anthropic_second");
    expect(pool.markUsed).toHaveBeenCalledWith("anthropic", "cred_anthropic_second");
    expect(piCodingAgentMockState.authStorageInMemory).toHaveBeenCalledWith({
      anthropic: { type: "oauth", access: "anthropic-token" },
      "openai-codex": { type: "oauth", access: "openai-token" },
    });
    const createOptions = piCodingAgentMockState.createAgentSession.mock.calls.at(-1)?.[0] as {
      authStorage?: unknown;
    };
    expect(createOptions.authStorage).toEqual({
      kind: "in-memory",
      data: {
        anthropic: { type: "oauth", access: "anthropic-token" },
        "openai-codex": { type: "oauth", access: "openai-token" },
      },
    });
    expect(runtime).toMatchObject({
      pooledCredentialId: "cred_anthropic_second",
      pooledCredentialProvider: "anthropic",
      credentialPoolService: pool,
    });
  });

  it("swallows and logs DefaultResourceLoader reload errors while still creating Pi runtime", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await seedProjectionFile(rootDir);
    setupPiModel();
    const logDebug = vi.fn();
    piCodingAgentMockState.defaultResourceLoaderReload.mockRejectedValueOnce(new Error("reload failed"));
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });

    const factory = createFactory(rootDir, { logDebug });
    const runtime = await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt");

    expect(runtime.runtimeType).toBe("pi");
    expect(logDebug).toHaveBeenCalledWith("runtime:resource_loader:reload_error", {
      agentId: "worker-1",
      message: "reload failed",
    });
    expect(piCodingAgentMockState.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("passes systemPrompt only to manager DefaultResourceLoader options and preserves worker append overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await seedProjectionFile(rootDir);
    setupPiModel();
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: createMockPiSession(),
      extensionsResult: { extensions: [], errors: [] },
    });
    const factory = createFactory(rootDir);

    await factory.createRuntimeForDescriptor(createManagerDescriptor(rootDir), "manager prompt");
    const managerOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      systemPrompt?: string;
      agentsFilesOverride?: unknown;
    };
    expect(managerOptions.systemPrompt).toBe("manager prompt");
    expect(managerOptions.agentsFilesOverride).toEqual(expect.any(Function));

    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "worker prompt");
    const workerOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      systemPrompt?: string;
      agentsFilesOverride?: unknown;
    };
    expect(workerOptions).not.toHaveProperty("systemPrompt");
    expect(workerOptions.agentsFilesOverride).toEqual(expect.any(Function));
  });

  it("guards Pi session manager opening before createAgentSession", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await seedProjectionFile(rootDir);
    setupPiModel();
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReturnValueOnce(null);
    const descriptor = createDescriptor(rootDir);
    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(descriptor, "system prompt")).rejects.toThrow(
      `Unable to open session file for agent worker-1: ${descriptor.sessionFile}`,
    );

    expect(sessionFileGuardMockState.openSessionManagerWithSizeGuard).toHaveBeenCalledWith(descriptor.sessionFile, {
      context: "runtime:create:pi:worker-1",
      rotateOversizedFile: true,
      logWarning: expect.any(Function),
    });
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("captures Pi extension snapshots, active tools, and bind error behavior", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await seedProjectionFile(rootDir);
    setupPiModel();
    const logDebug = vi.fn();
    const onRuntimeError = vi.fn(async () => undefined);
    const onRuntimeExtensionSnapshot = vi.fn(async () => undefined);
    const session = createMockPiSession();
    session.getActiveToolNames.mockReturnValue(["z_existing", "send_message_to_agent"]);
    session.bindExtensions.mockImplementationOnce(async ({ onError }: { onError: (error: any) => void }) => {
      onError({
        extensionPath: join(rootDir, "agent", "extensions", "broken.ts"),
        event: "session_start",
        error: " handler exploded ",
        stack: "stack trace",
      });
      throw new Error("bind failed");
    });
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session,
      extensionsResult: {
        extensions: [
          {
            path: "<inline forge bridge>",
            resolvedPath: "<inline forge bridge>",
            handlers: new Map(),
            tools: new Map(),
          },
          {
            path: join(rootDir, "agent", "extensions", "zeta.ts"),
            resolvedPath: join(rootDir, "agent", "extensions", "zeta.ts"),
            sourceInfo: undefined,
            handlers: new Map([["b_event", vi.fn()], ["a_event", vi.fn()]]),
            tools: new Map([["tool_b", vi.fn()], ["tool_a", vi.fn()]]),
          },
          {
            path: join(rootDir, "data", "profiles", "profile-1", "pi", "extensions", "alpha", "index.ts"),
            resolvedPath: join(rootDir, "data", "profiles", "profile-1", "pi", "extensions", "alpha", "index.ts"),
            sourceInfo: undefined,
            handlers: new Map([["c_event", vi.fn()]]),
            tools: new Map(),
          },
        ],
        errors: [
          { path: "<inline forge error>", error: "ignore" },
          { path: join(rootDir, "agent", "extensions", "bad-b.ts"), error: "bad b" },
          { path: join(rootDir, "agent", "extensions", "bad-a.ts"), error: "bad a" },
        ],
      },
    });

    const factory = createFactory(rootDir, {
      logDebug,
      callbacks: { onRuntimeError, onRuntimeExtensionSnapshot },
    });
    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt", 42);

    expect(onRuntimeExtensionSnapshot).toHaveBeenCalledWith(42, "worker-1", {
      agentId: "worker-1",
      role: "worker",
      managerId: "manager-1",
      profileId: "profile-1",
      loadedAt: "2026-01-01T00:00:00.000Z",
      extensions: [
        expect.objectContaining({
          displayName: "alpha",
          source: "profile",
          events: ["c_event"],
          tools: [],
        }),
        expect.objectContaining({
          displayName: "zeta.ts",
          source: "global-worker",
          events: ["a_event", "b_event"],
          tools: ["tool_a", "tool_b"],
        }),
      ],
      loadErrors: [
        { path: join(rootDir, "agent", "extensions", "bad-a.ts"), error: "bad a" },
        { path: join(rootDir, "agent", "extensions", "bad-b.ts"), error: "bad b" },
      ],
    });
    expect(onRuntimeError).toHaveBeenCalledWith(42, "worker-1", {
      phase: "extension",
      message: "handler exploded",
      stack: "stack trace",
      details: {
        extensionPath: join(rootDir, "agent", "extensions", "broken.ts"),
        event: "session_start",
      },
    });
    expect(logDebug).toHaveBeenCalledWith("extension:bind_error", {
      agentId: "worker-1",
      message: "bind failed",
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["z_existing", "send_message_to_agent", "list_agents"]),
    );
  });

  it("orders Pi Forge binding creation and does not activate bindings when createAgentSession fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await seedProjectionFile(rootDir);
    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(join(rootDir, "data", "extensions", "noop.ts"), "export default () => {}\n", "utf8");
    setupPiModel();
    const sequence: string[] = [];
    const session = createMockPiSession();
    session.bindExtensions.mockImplementation(async () => {
      sequence.push("bindExtensions");
    });
    session.setActiveToolsByName.mockImplementation(() => {
      sequence.push("setActiveTools");
    });
    session.subscribe.mockImplementation(() => {
      sequence.push("constructRuntime");
      return () => undefined;
    });
    piCodingAgentMockState.createAgentSession.mockImplementation(async () => {
      sequence.push("createAgentSession");
      return { session, extensionsResult: { extensions: [], errors: [] } };
    });
    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const originalPrepare = forgeExtensionHost.prepareRuntimeBindings.bind(forgeExtensionHost);
    vi.spyOn(forgeExtensionHost, "prepareRuntimeBindings").mockImplementation(async (...args) => {
      sequence.push("prepare");
      return originalPrepare(...args);
    });
    const originalActivate = forgeExtensionHost.activateRuntimeBindings.bind(forgeExtensionHost);
    const activateSpy = vi.spyOn(forgeExtensionHost, "activateRuntimeBindings").mockImplementation((...args) => {
      sequence.push("activate");
      return originalActivate(...args);
    });

    const factory = createFactory(rootDir, { forgeExtensionHost });
    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt", 9);

    expect(sequence).toEqual(["prepare", "createAgentSession", "bindExtensions", "setActiveTools", "constructRuntime", "activate"]);

    sequence.length = 0;
    activateSpy.mockClear();
    piCodingAgentMockState.createAgentSession.mockImplementationOnce(async () => {
      sequence.push("createAgentSession");
      throw new Error("session failed");
    });
    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt", 10)).rejects.toThrow("session failed");
    expect(sequence).toEqual(["prepare", "createAgentSession"]);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("passes auth headers and custom instructions to Pi compaction in the correct argument order", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

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

    const extensionFactories = buildExtensionFactories(rootDir, descriptor);

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
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "xai",
        modelId: "grok-4",
        thinkingLevel: "high",
      },
    });

    const extensionFactories = buildExtensionFactories(rootDir, descriptor);
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

  it("does not inject request-behavior handling for providers without catalog request behaviors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        thinkingLevel: "high",
      },
    });

    const extensionFactories = buildExtensionFactories(rootDir, descriptor);
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
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "xai",
        modelId: "grok-4",
        thinkingLevel: "high",
      },
      webSearch: true,
    });

    const extensionFactories = buildExtensionFactories(rootDir, descriptor);
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
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "xai",
        modelId: "grok-4",
        thinkingLevel: "high",
      },
      webSearch: false,
    });

    const extensionFactories = buildExtensionFactories(rootDir, descriptor);
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

  it("passes startup-only recovery overrides to the Claude runtime while preserving the base prompt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    claudeRuntimeMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-test",
      server: {},
      allowedTools: [],
    });

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
  });

  it("prepares and activates Claude Forge extension bindings with runtimeType claude and runtime token", async () => {
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

    const factory = createFactory(rootDir, { forgeExtensionHost });
    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "claude-sdk",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      17
    );

    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "claude",
        runtimeToken: 17,
      })
    );
    expect(activateSpy).toHaveBeenCalled();
    expect(activateSpy.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        runtimeType: "claude",
        bindingToken: "forge-runtime-17",
      })
    );
  });

  it("orders Claude Forge binding preparation, bridge creation, runtime construction, and activation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(join(rootDir, "data", "extensions", "noop.ts"), "export default () => {}\n", "utf8");

    const sequence: string[] = [];
    claudeRuntimeMockState.createMcpBridge.mockImplementation(async () => {
      sequence.push("bridge");
      return {
        serverName: "forge-test",
        server: {},
        allowedTools: [],
      };
    });
    claudeRuntimeMockState.constructImpl = () => {
      sequence.push("construct");
      return undefined;
    };

    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const originalPrepare = forgeExtensionHost.prepareRuntimeBindings.bind(forgeExtensionHost);
    vi.spyOn(forgeExtensionHost, "prepareRuntimeBindings").mockImplementation(async (...args) => {
      sequence.push("prepare");
      return originalPrepare(...args);
    });
    const originalActivate = forgeExtensionHost.activateRuntimeBindings.bind(forgeExtensionHost);
    vi.spyOn(forgeExtensionHost, "activateRuntimeBindings").mockImplementation((...args) => {
      sequence.push("activate");
      return originalActivate(...args);
    });

    const factory = createFactory(rootDir, { forgeExtensionHost });
    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "claude-sdk",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      18
    );

    expect(sequence).toEqual(["prepare", "bridge", "construct", "activate"]);
  });

  it("does not activate Claude Forge extension bindings when runtime construction throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(join(rootDir, "data", "extensions", "noop.ts"), "export default () => {}\n", "utf8");

    const constructionError = new Error("claude runtime failed");
    claudeRuntimeMockState.constructImpl = () => {
      throw constructionError;
    };

    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const activateSpy = vi.spyOn(forgeExtensionHost, "activateRuntimeBindings");
    const factory = createFactory(rootDir, { forgeExtensionHost });

    await expect(
      factory.createRuntimeForDescriptor(
        createDescriptor(rootDir, {
          model: {
            provider: "claude-sdk",
            modelId: "claude-opus-4-6",
            thinkingLevel: "high",
          },
        }),
        "system prompt",
        19
      )
    ).rejects.toBe(constructionError);

    expect(claudeRuntimeMockState.createMcpBridge).toHaveBeenCalledTimes(1);
    expect(claudeRuntimeMockState.constructorArgs).toHaveLength(1);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("passes Claude worker identity and runtime options unchanged into runtime construction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const mcpServer = { name: "server" };
    const allowedTools = ["send_message_to_agent", "speak_to_user"];
    claudeRuntimeMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-worker-test",
      server: mcpServer,
      allowedTools,
    });
    const getContextWindowSpy = vi
      .spyOn(modelCatalogService, "getEffectiveContextWindow")
      .mockReturnValueOnce(123456);
    const memoryContextFile = {
      path: join(rootDir, "worker-memory.md"),
      content: "worker memory",
    };
    const factory = createFactory(rootDir, {
      getMemoryRuntimeResources: async () => ({
        memoryContextFile,
        additionalSkillPaths: [],
        skillMetadata: [],
      }),
    });
    const descriptor = createDescriptor(rootDir, {
      agentId: "worker-claude-1",
      managerId: "manager-claude-1",
      profileId: "profile-claude-1",
      model: {
        provider: "claude-sdk",
        modelId: "claude-opus-4-6",
        thinkingLevel: "high",
      },
    });

    await factory.createRuntimeForDescriptor(descriptor, "system prompt", 20);

    const claudeOptions = claudeRuntimeMockState.constructorArgs.at(-1) as {
      profileId: string;
      sessionId: string;
      workerId?: string;
      dataDir: string;
      mcpServers: Record<string, unknown>;
      allowedTools: string[];
      runtimeEnv: Record<string, string>;
      modelContextWindow?: number;
    };
    expect(claudeOptions.profileId).toBe("profile-claude-1");
    expect(claudeOptions.sessionId).toBe("manager-claude-1");
    expect(claudeOptions.workerId).toBe("worker-claude-1");
    expect(claudeOptions.dataDir).toBe(join(rootDir, "data"));
    expect(claudeOptions.mcpServers).toEqual({ "forge-worker-test": mcpServer });
    expect(claudeOptions.allowedTools).toBe(allowedTools);
    expect(claudeOptions.runtimeEnv).toEqual({
      SWARM_DATA_DIR: join(rootDir, "data"),
      SWARM_MEMORY_FILE: memoryContextFile.path,
    });
    expect(claudeOptions.modelContextWindow).toBe(123456);
    expect(getContextWindowSpy).toHaveBeenCalledWith("claude-opus-4-6", "claude-sdk");
  });

  it("rejects Cursor SDK manager descriptors with v1 manager unsupported copy", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const factory = createFactory(rootDir);

    await expect(
      factory.createRuntimeForDescriptor(
        createManagerDescriptor(rootDir, {
          model: {
            provider: "cursor-sdk",
            modelId: "composer-2.5",
            thinkingLevel: "medium",
          },
        }),
        "system prompt",
        3
      )
    ).rejects.toThrow(
      "Cursor SDK manager runtimes are not supported in this release. Use Cursor SDK through a specialist worker."
    );

    expect(acpRuntimeMockState.create).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("selects the Cursor SDK runtime for worker descriptors without falling through to Pi or ACP", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    process.env.CURSOR_API_KEY = "cursor-test-key";
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });
    const close = vi.fn();
    const create = vi.fn(async () => ({
      agentId: "sdk-agent-1",
      close,
      send: vi.fn(),
    }));
    setCursorSdkImporterForTests(async () => ({
      Agent: { create, resume: vi.fn() },
      Cursor: { models: { list: vi.fn() } },
    }));
    const buildCursorSdkRuntimeSystemPrompt = vi.fn(async (_descriptor: AgentDescriptor, systemPrompt: string) => `${systemPrompt}\n\nCursor prompt`);

    const factory = createFactory(rootDir, { buildCursorSdkRuntimeSystemPrompt });
    const runtime = await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
      }),
      "Base Cursor prompt",
      3
    );

    expect(runtime.runtimeType).toBe("cursor-sdk");
    expect(buildCursorSdkRuntimeSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({ agentId: "worker-1" }), "Base Cursor prompt");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "cursor-test-key",
      model: { id: "composer-2.5", params: [{ id: "thinking", value: "medium" }] },
      local: { cwd: rootDir, settingSources: [] },
      platform: { stateRoot: join(rootDir, "cursor-sdk-state", "worker-1"), workspaceRef: rootDir },
      mcpServers: expect.objectContaining({ "forge-swarm-worker-1": expect.objectContaining({ type: "http" }) }),
    }));
    expect(acpRuntimeMockState.create).not.toHaveBeenCalled();
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
    await runtime.terminate();
    expect(close).toHaveBeenCalled();
  });

  it("does not create a Cursor SDK MCP bridge when auth is missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });
    setCursorSdkImporterForTests(async () => ({
      Agent: { create: vi.fn(), resume: vi.fn() },
      Cursor: { models: { list: vi.fn() } },
    }));

    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir, {
      model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
    }), "Base Cursor prompt", 3)).rejects.toThrow(/Cursor SDK API key/);
    expect(cursorMcpMockState.createMcpBridge).not.toHaveBeenCalled();
  });

  it("does not create a Cursor SDK MCP bridge when prompt assembly fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    process.env.CURSOR_API_KEY = "cursor-test-key";
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });
    setCursorSdkImporterForTests(async () => ({
      Agent: { create: vi.fn(), resume: vi.fn() },
      Cursor: { models: { list: vi.fn() } },
    }));

    const factory = createFactory(rootDir, {
      buildCursorSdkRuntimeSystemPrompt: vi.fn(async () => {
        throw new Error("prompt failed");
      }),
    });

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir, {
      model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
    }), "Base Cursor prompt", 3)).rejects.toThrow("prompt failed");
    expect(cursorMcpMockState.createMcpBridge).not.toHaveBeenCalled();
  });

  it("does not create a Cursor SDK MCP bridge when model selection is invalid", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    process.env.CURSOR_API_KEY = "cursor-test-key";
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });
    setCursorSdkImporterForTests(async () => ({
      Agent: { create: vi.fn(), resume: vi.fn() },
      Cursor: { models: { list: vi.fn() } },
    }));

    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir, {
      model: { provider: "cursor-sdk", modelId: "not-composer", thinkingLevel: "medium" },
    }), "Base Cursor prompt", 3)).rejects.toThrow(/Unsupported Cursor SDK model/);
    expect(cursorMcpMockState.createMcpBridge).not.toHaveBeenCalled();
  });

  it("shuts down the Cursor SDK MCP bridge when runtime creation fails after bridge creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    process.env.CURSOR_API_KEY = "cursor-test-key";
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });
    const shutdown = vi.fn(async () => undefined);
    cursorMcpMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-swarm-worker-1",
      mcpServers: { "forge-swarm-worker-1": { type: "http", url: "http://127.0.0.1:1/mcp" } },
      shutdown,
    });
    setCursorSdkImporterForTests(async () => ({
      Agent: { create: vi.fn(async () => { throw new Error("sdk create failed"); }), resume: vi.fn() },
      Cursor: { models: { list: vi.fn() } },
    }));

    const factory = createFactory(rootDir);

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir, {
      model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
    }), "Base Cursor prompt", 3)).rejects.toThrow("sdk create failed");
    expect(cursorMcpMockState.createMcpBridge).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("closes the Cursor SDK MCP bridge once across terminate and recycle cleanup paths", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    process.env.CURSOR_API_KEY = "cursor-test-key";
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });
    const shutdown = vi.fn(async () => undefined);
    cursorMcpMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-swarm-worker-1",
      mcpServers: { "forge-swarm-worker-1": { type: "http", url: "http://127.0.0.1:1/mcp" } },
      shutdown,
    });
    const close = vi.fn();
    setCursorSdkImporterForTests(async () => ({
      Agent: { create: vi.fn(async () => ({ agentId: "sdk-agent-1", close, send: vi.fn() })), resume: vi.fn() },
      Cursor: { models: { list: vi.fn() } },
    }));

    const factory = createFactory(rootDir);
    const runtime = await factory.createRuntimeForDescriptor(createDescriptor(rootDir, {
      model: { provider: "cursor-sdk", modelId: "composer-2.5", thinkingLevel: "medium" },
    }), "Base Cursor prompt", 3);

    await runtime.recycle();
    await runtime.terminate({ abort: false });
    expect(shutdown).toHaveBeenCalledTimes(1);
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

  it("fails ACP prompt assembly before bridge creation or runtime creation", async () => {
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

  it("shuts down the ACP MCP bridge when runtime creation fails after bridge creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });

    const shutdown = vi.fn(async () => undefined);
    const creationError = new Error("acp runtime failed");
    acpRuntimeMockState.createMcpBridge.mockResolvedValue({
      mcpDescriptor: {
        type: "http",
        name: "forge-tools",
        url: "http://127.0.0.1:4321/mcp",
        headers: [],
      },
      shutdown,
    });
    acpRuntimeMockState.create.mockRejectedValue(creationError);

    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const activateSpy = vi.spyOn(forgeExtensionHost, "activateRuntimeBindings");
    const factory = createFactory(rootDir, { forgeExtensionHost });

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
    ).rejects.toBe(creationError);

    expect(acpRuntimeMockState.createMcpBridge).toHaveBeenCalledTimes(1);
    expect(acpRuntimeMockState.create).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("closes the ACP MCP bridge once across successful runtime lifecycle cleanup methods", async () => {
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
    const runtimeImpl = createMockRuntime({ runtimeType: "acp" });
    const originalTerminate = runtimeImpl.terminate;
    const originalShutdownForReplacement = runtimeImpl.shutdownForReplacement;
    const originalRecycle = runtimeImpl.recycle;
    acpRuntimeMockState.create.mockResolvedValue(runtimeImpl);

    const factory = createFactory(rootDir);
    const runtime = await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "cursor-acp",
          modelId: "default",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      9
    );

    await runtime.terminate();
    await runtime.shutdownForReplacement();
    await runtime.recycle();

    expect(originalTerminate).toHaveBeenCalledTimes(1);
    expect(originalShutdownForReplacement).toHaveBeenCalledTimes(1);
    expect(originalRecycle).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("orders ACP Forge binding preparation, bridge creation, cleanup binding, and activation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, "data", "extensions"), { recursive: true });
    await writeFile(join(rootDir, "data", "extensions", "noop.ts"), "export default () => {}\n", "utf8");

    const sequence: string[] = [];
    const shutdown = vi.fn(async () => undefined);
    const runtimeImpl = createMockRuntime({ runtimeType: "acp" });
    const originalTerminate = runtimeImpl.terminate;
    let cleanupWasBoundAtActivation = false;

    acpRuntimeMockState.createMcpBridge.mockImplementation(async () => {
      sequence.push("bridge");
      return {
        mcpDescriptor: {
          type: "http",
          name: "forge-tools",
          url: "http://127.0.0.1:4321/mcp",
          headers: [],
        },
        shutdown,
      };
    });
    acpRuntimeMockState.create.mockImplementation(async () => {
      sequence.push("create");
      return runtimeImpl;
    });

    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const originalPrepare = forgeExtensionHost.prepareRuntimeBindings.bind(forgeExtensionHost);
    vi.spyOn(forgeExtensionHost, "prepareRuntimeBindings").mockImplementation(async (...args) => {
      sequence.push("prepare");
      return originalPrepare(...args);
    });
    const originalActivate = forgeExtensionHost.activateRuntimeBindings.bind(forgeExtensionHost);
    vi.spyOn(forgeExtensionHost, "activateRuntimeBindings").mockImplementation((...args) => {
      cleanupWasBoundAtActivation = runtimeImpl.terminate !== originalTerminate;
      sequence.push("activate");
      return originalActivate(...args);
    });

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
      10
    );

    expect(sequence).toEqual(["prepare", "bridge", "create", "activate"]);
    expect(cleanupWasBoundAtActivation).toBe(true);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("passes an ACP unexpected-exit hook that shuts down the MCP bridge", async () => {
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
    acpRuntimeMockState.create.mockImplementation(async (options: { onUnexpectedExit: () => Promise<void> }) => {
      expect(options.onUnexpectedExit).toEqual(expect.any(Function));
      return createMockRuntime({ runtimeType: "acp" });
    });

    const factory = createFactory(rootDir);
    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: {
          provider: "cursor-acp",
          modelId: "default",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      11
    );

    const acpOptions = acpRuntimeMockState.create.mock.calls.at(-1)?.[0] as {
      onUnexpectedExit: () => Promise<void>;
    };
    await acpOptions.onUnexpectedExit();

    expect(shutdown).toHaveBeenCalledTimes(1);
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

  it("wraps Forge-owned tools for Claude and ACP runtimes", async () => {
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
          provider: "cursor-acp",
          modelId: "default",
          thinkingLevel: "high",
        },
      }),
      "system prompt",
      2
    );
    const acpTools = acpRuntimeMockState.createMcpBridge.mock.calls.at(-1)?.[0] as Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }>;
    await acpTools.find((tool) => tool.name === "send_message_to_agent")?.execute("tool-acp", {
      targetAgentId: "worker-original",
      message: "hello",
    });

    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([
      "worker-rewritten",
      "worker-rewritten",
    ]);
  });
});
