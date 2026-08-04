import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPiModelsProjectionPath } from "../model-catalog-projection.js";
import { createDefaultCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
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
  settingsManagerGetShellCommandPrefix: vi.fn(),
  settingsManagerGetShellPath: vi.fn(),
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

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getModel: (provider: unknown, modelId: unknown) => piAiMockState.getModel(provider, modelId),
  getModels: (provider: unknown) => piAiMockState.getModels(provider),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent")
  return {
    ...actual,
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
          getShellCommandPrefix: () => piCodingAgentMockState.settingsManagerGetShellCommandPrefix(),
          getShellPath: () => piCodingAgentMockState.settingsManagerGetShellPath(),
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
  }
});

vi.mock("../session-file-guard.js", () => ({
  openSessionManagerWithSizeGuard: (...args: unknown[]) => sessionFileGuardMockState.openSessionManagerWithSizeGuard(...args),
}));

vi.mock("../runtime/cursor-sdk/cursor-sdk-mcp-tool-bridge.js", () => ({
  createCursorSdkMcpToolBridge: (...args: unknown[]) => cursorMcpMockState.createMcpBridge(...args),
}));

vi.mock("../runtime-prompt-assembler.js", () => ({
  assembleRuntimePrompt: vi.fn(async ({ basePrompt }: { basePrompt: string }) => basePrompt),
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

import { savePins } from "../message-pins.js";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import { RuntimeFactory } from "../runtime-factory.js";
import { resetCursorSdkLoaderForTests, setCursorSdkImporterForTests } from "../runtime/cursor-sdk/cursor-sdk-loader.js";
import type { SkillMetadata } from "../skills/skill-metadata-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import {
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  type SecureRuntimeBinding,
} from "../secure-sessions/runtime/secure-runtime-binding.js";

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
    getSecureRuntimeBinding?: (descriptor: AgentDescriptor) => SecureRuntimeBinding | undefined;
    getCredentialPoolService?: () => any;
    getOpenAIAuthBrokerRuntimeService?: () => any;
    observability?: any;
    getMemoryRuntimeResources?: (descriptor: AgentDescriptor) => Promise<{
      memoryContextFile: { path: string; content: string };
      additionalSkillPaths: string[];
      skillMetadata: SkillMetadata[];
    }>;
    buildCursorSdkRuntimeSystemPrompt?: (descriptor: AgentDescriptor, systemPrompt: string) => Promise<string>;
    callbacks?: Partial<{
      onRuntimeError: (runtimeToken: number, agentId: string, error: unknown) => Promise<void>;
      onGenerationEvent: (runtimeToken: number, agentId: string, event: unknown) => Promise<void>;
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
    getSecureRuntimeBinding: overrides.getSecureRuntimeBinding,
    getCredentialPoolService: overrides.getCredentialPoolService,
    getOpenAIAuthBrokerRuntimeService: overrides.getOpenAIAuthBrokerRuntimeService,
    observability: overrides.observability,
    getCompactionRuntimeSettingsProvider:
      overrides.getCompactionRuntimeSettingsProvider ??
      (() => createDefaultCompactionRuntimeSettingsProvider()),
    getMemoryRuntimeResources: overrides.getMemoryRuntimeResources ?? (async () => ({
      memoryContextFile: {
        path: join(rootDir, "memory.md"),
        content: "",
      },
      additionalSkillPaths: [],
      skillMetadata: [],
    })),
    getSwarmContextFiles: async () => [],
    resolveProjectExecutableTrustPlan: async () => ({
      trusted: false,
      trustedForgeExtensionDirs: [],
      trustedPiExtensionDirs: [],
      trustedPiSettingsPaths: [],
    }),
    buildCursorSdkRuntimeSystemPrompt:
      overrides.buildCursorSdkRuntimeSystemPrompt ?? (async (_descriptor, systemPrompt) => systemPrompt),
    mergeRuntimeContextFiles: (base) => base,
    callbacks: {
      onStatusChange: async () => {},
      onSessionEvent: async () => {},
      onAgentEnd: async () => {},
      onRuntimeError: overrides.callbacks?.onRuntimeError ?? (async () => {}),
      onGenerationEvent: overrides.callbacks?.onGenerationEvent ?? (async () => {}),
      onRuntimeExtensionSnapshot: overrides.callbacks?.onRuntimeExtensionSnapshot ?? (async () => {}),
    },
  });
}

function createMockPiSession() {
  return {
    isStreaming: true,
    sessionId: "mock-pi-session",
    agent: {
      streamFn: vi.fn(async () => ({ kind: "mock-stream" })),
      prompt: vi.fn(async () => undefined),
      continue: vi.fn(async () => undefined),
      transformContext: vi.fn(async (messages: unknown, _signal?: AbortSignal) => messages),
    },
    bindExtensions: vi.fn(async () => undefined),
    getActiveToolNames: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    getToolDefinition: vi.fn(() => undefined),
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

function buildExtensionFactories(rootDir: string, descriptor: AgentDescriptor) {
  return planPiExtensionFactories({
    descriptor,
    config: createConfig(rootDir),
    logDebug: () => {},
    getCompactionRuntimeSettingsProvider: () => createDefaultCompactionRuntimeSettingsProvider(),
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

describe("RuntimeFactory", () => {
  beforeEach(() => {
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
    piCodingAgentMockState.settingsManagerGetShellCommandPrefix.mockReset();
    piCodingAgentMockState.settingsManagerGetShellCommandPrefix.mockReturnValue(undefined);
    piCodingAgentMockState.settingsManagerGetShellPath.mockReset();
    piCodingAgentMockState.settingsManagerGetShellPath.mockReturnValue(undefined);
    delete process.env.FORGE_OPENAI_CODEX_TRANSPORT;
    cursorMcpMockState.createMcpBridge.mockReset();
    cursorMcpMockState.createMcpBridge.mockResolvedValue({
      serverName: "forge-swarm-worker-1",
      mcpServers: { "forge-swarm-worker-1": { type: "http", url: "http://127.0.0.1:1/mcp" } },
      shutdown: vi.fn(async () => undefined),
    });
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReset();
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReturnValue({});
  });

  it("rejects unmigrated Cursor ACP descriptors instead of falling through to Pi", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: {
        provider: "cursor-acp",
        modelId: "default",
        thinkingLevel: "medium",
      },
    });

    await expect(factory.createRuntimeForDescriptor(descriptor, "prompt")).rejects.toThrow(
      "Cursor ACP has been removed",
    );
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("rejects an unmapped legacy Claude SDK descriptor before runtime dispatch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: { provider: "claude-sdk", modelId: "claude-future-unknown", thinkingLevel: "high" },
    });

    await expect(factory.createRuntimeForDescriptor(descriptor, "prompt")).rejects.toThrow(
      "Choose a native Anthropic model",
    );
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
    expect(cursorMcpMockState.createMcpBridge).not.toHaveBeenCalled();
  });

  it.each([
    ["openai-codex", "gpt-5.3-codex-spark"],
    ["anthropic", "claude-sonnet-4-5-20250929"],
    ["anthropic", "claude-haiku-4-5-20251001"],
    ["openrouter", "anthropic/claude-sonnet-4.5"],
    ["openrouter", "~anthropic/claude-haiku-latest"],
    ["openrouter", "openai/gpt-5.3-codex-spark"],
  ])("rejects retired runtime model %s/%s before provider dispatch", async (provider, modelId) => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      model: { provider, modelId, thinkingLevel: "medium" },
    });

    await expect(factory.createRuntimeForDescriptor(descriptor, "prompt")).rejects.toThrow("retired model");
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("rejects external-thread sidecar descriptors before runtime provider dispatch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir, {
      role: "worker",
      agentId: "mgr-1--codex",
      model: {
        provider: "codex-app-server",
        modelId: "app-server",
        thinkingLevel: "none",
      },
      externalThread: {
        type: "codex_app_server",
        persisted: true,
        createdByMention: true,
      },
    });

    await expect(factory.createRuntimeForDescriptor(descriptor, "prompt")).rejects.toThrow(/external-thread sidecar/);
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
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

  it("chains count-only Pi generation telemetry through the public streamFn callback plumbing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const piSession = createMockPiSession();
    const priorStreamFn = piSession.agent.streamFn;
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: piSession,
      extensionsResult: { extensions: [], errors: [] },
    });
    const onGenerationEvent = vi.fn(async () => undefined);
    const factory = createFactory(rootDir, { callbacks: { onGenerationEvent } });

    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt", 41);
    const telemetrySubscriber = piSession.subscribe.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
    telemetrySubscriber?.({ type: "agent_start" });
    await expect(piSession.agent.streamFn(
      { provider: "anthropic", id: "claude-test", api: "anthropic-messages" },
      {},
      {},
    )).resolves.toEqual({ kind: "mock-stream" });

    expect(priorStreamFn).toHaveBeenCalledOnce();
    expect(onGenerationEvent).toHaveBeenCalledWith(41, "worker-1", expect.objectContaining({
      phase: "request_started",
      requestedProvider: "anthropic",
      requestedModelId: "claude-test",
      measurementScope: "agent_model_call",
    }));
  });

  it("installs provider-context image normalization on every created Pi session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const piSession = createMockPiSession();
    const existingTransform = piSession.agent.transformContext;
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: piSession,
      extensionsResult: { extensions: [], errors: [] },
    });
    const factory = createFactory(rootDir);

    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt");

    expect(piSession.agent.transformContext).not.toBe(existingTransform);
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const signal = new AbortController().signal;
    await piSession.agent.transformContext(messages, signal);
    expect(existingTransform).toHaveBeenCalledWith(messages, signal);
  });

  it("keeps host Bash and adds secure Bash while replacing unsafe built-ins and extensions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const piSession = createMockPiSession();
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: piSession,
      extensionsResult: { extensions: [], errors: [] },
    });
    const secureRuntimeBinding = {
      executeBash: vi.fn(async () => ({ exitCode: 0 })),
      createOutputGuard: vi.fn(() => ({
        write: (data: Uint8Array) => Buffer.from(data),
        close: async () => Buffer.alloc(0),
        dispose: vi.fn(),
      })),
      guardValue: <T>(value: T) => value,
      debugSerializationCanary: "binding-must-not-be-serialized",
    } satisfies SecureRuntimeBinding & { debugSerializationCanary: string };
    const logDebug = vi.fn();
    const observability = {
      recordPromptResolved: vi.fn(),
      recordRuntimeCreated: vi.fn(),
    };
    const factory = createFactory(rootDir, {
      getSecureRuntimeBinding: () => secureRuntimeBinding,
      logDebug,
      observability,
    });

    await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir),
      "system prompt",
      18,
      { secureRuntimeRequired: true },
    );

    const sessionOptions = piCodingAgentMockState.createAgentSession.mock.calls.at(-1)?.[0] as {
      noTools?: string;
      tools?: string[];
      customTools?: Array<{ name: string }>;
    };
    expect(sessionOptions.noTools).toBe("builtin");
    expect(sessionOptions.tools).toEqual(
      expect.arrayContaining(["bash", "secure_bash", "read", "edit", "write", "grep", "find", "ls"]),
    );
    expect(sessionOptions.customTools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["bash", "secure_bash", "read", "edit", "write", "grep", "find", "ls"]),
    );

    const loaderOptions = piCodingAgentMockState.defaultResourceLoaderCtor.mock.calls.at(-1)?.[0] as {
      noExtensions?: boolean;
      additionalExtensionPaths?: string[];
      extensionFactories?: unknown[];
    };
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.additionalExtensionPaths).toEqual([]);
    expect(loaderOptions.extensionFactories).toEqual(expect.any(Array));
    expect(piSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["bash", "secure_bash", "read", "edit", "write", "grep", "find", "ls"]),
    );
    expect(piCodingAgentMockState.settingsManagerGetShellCommandPrefix).toHaveBeenCalledOnce();
    expect(piCodingAgentMockState.settingsManagerGetShellPath).toHaveBeenCalledOnce();
    expect(JSON.stringify(logDebug.mock.calls)).not.toContain(
      secureRuntimeBinding.debugSerializationCanary,
    );
    expect(JSON.stringify(observability)).not.toContain(
      secureRuntimeBinding.debugSerializationCanary,
    );
  });

  it("does not create an ordinary runtime when a secure binding is required", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const factory = createFactory(rootDir, {
      getSecureRuntimeBinding: () => undefined,
    });

    await expect(
      factory.createRuntimeForDescriptor(
        createDescriptor(rootDir),
        "system prompt",
        17,
        { secureRuntimeRequired: true },
      ),
    ).rejects.toThrow(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);

    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
  });

  it("records Pi runtime prompt and creation observability metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const piSession = createMockPiSession();
    piSession.systemPrompt = "final pi system prompt";
    piSession.getActiveToolNames.mockReturnValue(["extension_search", "send_message_to_agent"]);
    piSession.getAllTools.mockReturnValue([
      {
        name: "extension_search",
        description: "Search from extension",
        parameters: { type: "object", properties: { q: { type: "string" } } },
        source: "project-local",
      },
    ]);
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: piSession,
      extensionsResult: { extensions: [], errors: [] },
    });
    const observability = {
      recordPromptResolved: vi.fn(),
      recordRuntimeCreated: vi.fn(),
    };
    const factory = createFactory(rootDir, { observability });
    const descriptor = createDescriptor(rootDir, { displayName: "Backend Worker" });

    await factory.createRuntimeForDescriptor(descriptor, "resolved Forge prompt", 42);

    expect(observability.recordPromptResolved).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "worker-1",
      managerId: "manager-1",
      profileId: "profile-1",
      runtimeType: "pi",
      runtimeToken: 42,
      source: "forge_resolved",
      prompt: "resolved Forge prompt",
      modelProvider: "openai-codex",
      modelId: "gpt-5.4-mini",
    }));
    expect(observability.recordPromptResolved).toHaveBeenCalledWith(expect.objectContaining({
      source: "runtime_final",
      prompt: "final pi system prompt",
    }));
    expect(observability.recordRuntimeCreated).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "worker-1",
      runtimeType: "pi",
      runtimeToken: 42,
      status: "ready",
      finalSystemPrompt: "final pi system prompt",
      activeTools: expect.arrayContaining([
        expect.objectContaining({ name: "send_message_to_agent" }),
        expect.objectContaining({
          name: "extension_search",
          description: "Search from extension",
          jsonSchema: { type: "object", properties: { q: { type: "string" } } },
          source: "project-local",
        }),
      ]),
    }));
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
        expect.objectContaining({ projectTrusted: false }),
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

  it("preserves configured provider retries while omitting irrelevant Codex transport overrides", async () => {
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
      expect.objectContaining({ projectTrusted: false }),
    );
    expect(piCodingAgentMockState.settingsManagerApplyOverrides).not.toHaveBeenCalledWith(
      expect.objectContaining({ retry: expect.anything() }),
    );
    expect(piCodingAgentMockState.settingsManagerApplyOverrides).not.toHaveBeenCalledWith(
      expect.objectContaining({ transport: expect.anything() }),
    );
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
      expect.arrayContaining(["z_existing", "send_message_to_agent", "knowledge"]),
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

    expect(sequence).toEqual([
      "prepare",
      "createAgentSession",
      "constructRuntime", // Generation telemetry subscribes before runtime mapping.
      "bindExtensions",
      "setActiveTools",
      "constructRuntime",
      "activate",
    ]);

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

  it("releases acquired OpenAI broker leases when Pi runtime creation fails before attach", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await seedProjectionFile(rootDir);
    setupPiModel();
    const brokerHandle = {
      leaseId: "lease-runtime-create-fail",
      identity: { clientId: "forge", instanceId: "forge" },
      renewedAtMs: Date.now(),
      lease: {
        leaseId: "lease-runtime-create-fail",
        credential: {
          type: "oauth" as const,
          access: "leased-access-token",
          expires: Date.now() + 3_600_000,
          accountId: "broker-account-1",
        },
      },
    };
    const brokerRuntimeService = {
      isBrokerModeActive: vi.fn(async () => true),
      acquireForRuntime: vi.fn(async () => ({ authStorage: { kind: "broker-auth-storage" }, handle: brokerHandle })),
      release: vi.fn(async () => undefined),
    };
    piCodingAgentMockState.createAgentSession.mockRejectedValueOnce(new Error("createAgentSession failed"));

    const factory = createFactory(rootDir, { getOpenAIAuthBrokerRuntimeService: () => brokerRuntimeService });

    await expect(factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt", 11)).rejects.toThrow(
      "createAgentSession failed",
    );
    expect(brokerRuntimeService.acquireForRuntime).toHaveBeenCalledTimes(1);
    expect(brokerRuntimeService.release).toHaveBeenCalledWith(brokerHandle, "runtime_create_failed");
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
    const compactionModel = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
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
          find: vi.fn((provider: string, modelId: string) => {
            if (provider === "openai-codex" && modelId === "gpt-5.5") {
              return compactionModel;
            }
            return undefined;
          }),
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
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
      },
      compactionModel,
      "oauth-access-token",
      { Authorization: "Bearer oauth-access-token", "x-test": "1" },
      expect.stringContaining("Focus on deployment details."),
      signal,
      "low",
      undefined,
      undefined,
    );
    expect(result).toEqual({
      compaction: expect.objectContaining({
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      }),
    });
    expect(result?.compaction?.details).toMatchObject({
      forgeCompaction: expect.objectContaining({
        sourcePath: "forge_session_before_compact",
        bounding: expect.any(Object),
      }),
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

    const descriptor = createManagerDescriptor(rootDir);
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

  it("does not expose manager coordination tools to ordinary Pi worker runtimes", async () => {
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

    expect(tools.map((tool) => tool.name)).toEqual(["knowledge"]);
    expect(sendTool).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
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

  it("persists one safe Pi initial-model-input capture from the public streamFn seam", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const piSession = createMockPiSession();
    const appendCustomEntry = vi.fn(() => "initial-input-entry");
    const sessionManager = {
      getEntries: () => [],
      appendCustomEntry,
    };
    piSession.sessionManager = sessionManager;
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReturnValue(sessionManager);
    piCodingAgentMockState.createAgentSession.mockResolvedValue({
      session: piSession,
      extensionsResult: { extensions: [], errors: [] },
    });
    const factory = createFactory(rootDir);

    await factory.createRuntimeForDescriptor(createDescriptor(rootDir), "system prompt", 42);
    const telemetrySubscriber = piSession.subscribe.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
    telemetrySubscriber?.({ type: "agent_start" });
    await piSession.agent.streamFn(
      { provider: "openai-codex", id: "gpt-5.4-mini", api: "openai-codex-responses" },
      {
        systemPrompt: "Final prompt from before_agent_start",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "hello", password: "message-level value" },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ],
        }],
        tools: [{
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              token: { type: "string", description: "A user-provided token field" },
            },
          },
          execute: () => undefined,
        }],
      },
      {
        reasoning: "high",
        maxTokens: 4_096,
        token: "top-level secret",
        apiKey: "secret",
        auth: "secret",
        accessToken: "secret",
        "x-api-key": "secret",
        headers: { authorization: "secret" },
        env: { TOKEN: "secret" },
        metadata: { traceId: "trace-1", auth: "secret", token: "nested secret" },
      },
    );

    expect(appendCustomEntry).toHaveBeenCalledOnce();
    expect(appendCustomEntry).toHaveBeenCalledWith("swarm_pi_initial_model_input", {
      version: 1,
      runtime: "pi",
      capturedAt: expect.any(String),
      fidelity: {
        capturePoint: "pi_stream_fn",
        context: "exact_provider_independent",
        images: "byte_summary",
        requestMetadata: "safe_projection",
      },
      systemPrompt: "Final prompt from before_agent_start",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "hello", password: "message-level value" },
          { type: "image", mimeType: "image/png", dataBytes: 5 },
        ],
      }],
      tools: [{
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            token: { type: "string", description: "A user-provided token field" },
          },
        },
      }],
      model: {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
        api: "openai-codex-responses",
      },
      requestMetadata: {
        reasoning: "high",
        maxTokens: 4_096,
        metadata: { traceId: "trace-1" },
      },
    });
  });

  it("does not append another initial-model-input capture after a Pi runtime is recreated", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    setupPiModel();
    const firstSession = createMockPiSession();
    const recreatedSession = createMockPiSession();
    const appendCustomEntry = vi.fn(() => "initial-input-entry");
    const sessionEntries: unknown[] = [];
    const sessionManager = {
      getEntries: () => sessionEntries,
      appendCustomEntry,
    };
    firstSession.sessionManager = sessionManager;
    recreatedSession.sessionManager = sessionManager;
    sessionFileGuardMockState.openSessionManagerWithSizeGuard.mockReturnValue(sessionManager);
    piCodingAgentMockState.createAgentSession
      .mockResolvedValueOnce({ session: firstSession, extensionsResult: { extensions: [], errors: [] } })
      .mockResolvedValueOnce({ session: recreatedSession, extensionsResult: { extensions: [], errors: [] } });
    const factory = createFactory(rootDir);
    const descriptor = createDescriptor(rootDir);

    await factory.createRuntimeForDescriptor(descriptor, "system prompt", 1);
    sessionEntries.push({
      type: "custom",
      customType: "swarm_pi_initial_model_input",
      data: {
        version: 1,
        runtime: "pi",
        capturedAt: "2026-01-01T00:00:00.000Z",
        fidelity: {
          capturePoint: "pi_stream_fn",
          context: "exact_provider_independent",
          images: "byte_summary",
          requestMetadata: "safe_projection",
        },
        systemPrompt: "existing first request",
        messages: [],
        tools: [],
        model: { provider: "openai-codex", id: "gpt-5.4-mini" },
        requestMetadata: {},
      },
    });

    await factory.createRuntimeForDescriptor(descriptor, "system prompt", 2);
    const telemetrySubscriber = recreatedSession.subscribe.mock.calls[0]?.[0] as ((event: unknown) => void) | undefined;
    telemetrySubscriber?.({ type: "agent_start" });
    await recreatedSession.agent.streamFn(
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { systemPrompt: "new request", messages: [], tools: [] },
      {},
    );

    expect(appendCustomEntry).not.toHaveBeenCalled();
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

  it("passes startup-only recovery overrides to the Cursor SDK runtime while preserving the base prompt", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-factory-"));
    await mkdir(rootDir, { recursive: true });
    process.env.CURSOR_API_KEY = "cursor-test-key";
    piCodingAgentMockState.authStorageCreate.mockReturnValue({ get: () => undefined });

    const descriptor = createManagerDescriptor(rootDir, {
      model: {
        provider: "cursor-sdk",
        modelId: "composer-2.5",
        thinkingLevel: "medium",
      },
    });
    await writeFile(descriptor.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "now", cwd: rootDir })}\n${JSON.stringify({
      type: "custom",
      customType: "swarm_cursor_sdk_runtime_state",
      id: "state-1",
      parentId: "session-1",
      timestamp: "now",
      data: {
        version: 1,
        sdkAgentId: "persisted-agent",
        model: descriptor.model,
        cwd: rootDir,
        stateRoot: join(rootDir, "cursor-sdk-state", descriptor.agentId),
        savedAt: "old",
      },
    })}\n`, "utf8");

    const resume = vi.fn(async () => ({
      agentId: "persisted-agent",
      close: vi.fn(),
      send: vi.fn(),
    }));
    const create = vi.fn(async () => ({
      agentId: "fresh-sdk-agent",
      close: vi.fn(),
      send: vi.fn(async () => ({
        id: "run-1",
        agentId: "fresh-sdk-agent",
        status: "finished",
        stream: async function* () {},
        wait: vi.fn(async () => ({ status: "finished" })),
        cancel: vi.fn(async () => undefined),
      })),
    }));
    setCursorSdkImporterForTests(async () => ({
      Agent: { create, resume },
      Cursor: { models: { list: vi.fn() } },
    }));

    const factory = createFactory(rootDir);
    const runtime = await factory.createRuntimeForDescriptor(descriptor, "Base Cursor prompt", 1, {
      startupRecoveryContext: {
        reason: "model_change",
        blockText: "# Recovered Forge Conversation Context\nRecovered history",
        requestId: "req-1",
      },
    });

    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.getSystemPrompt?.()).toBe("Base Cursor prompt");
  });

  it("supports Cursor SDK descriptors for manager creation", async () => {
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

    const factory = createFactory(rootDir);
    const runtime = await factory.createRuntimeForDescriptor(
      createManagerDescriptor(rootDir, {
        model: {
          provider: "cursor-sdk",
          modelId: "composer-2.5",
          thinkingLevel: "medium",
        },
      }),
      "system prompt",
      3
    );

    expect(runtime.runtimeType).toBe("cursor-sdk");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "cursor-test-key",
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      platform: { stateRoot: join(rootDir, "cursor-sdk-state", "manager-1"), workspaceRef: rootDir },
    }));

    await runtime.terminate();
    expect(close).toHaveBeenCalled();
  });

  it("selects the Cursor SDK runtime for worker descriptors without falling through to Pi", async () => {
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
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      local: { cwd: rootDir, settingSources: [] },
      platform: { stateRoot: join(rootDir, "cursor-sdk-state", "worker-1"), workspaceRef: rootDir },
      mcpServers: expect.objectContaining({ "forge-swarm-worker-1": expect.objectContaining({ type: "http" }) }),
    }));
    expect(piCodingAgentMockState.createAgentSession).not.toHaveBeenCalled();
    await runtime.terminate();
    expect(close).toHaveBeenCalled();
  });

  it("maps Cursor SDK Grok 4.5 Fast descriptors to the SDK id plus effort and fast params", async () => {
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

    const factory = createFactory(rootDir);
    const runtime = await factory.createRuntimeForDescriptor(
      createDescriptor(rootDir, {
        model: { provider: "cursor-sdk", modelId: "grok-4.5-fast", thinkingLevel: "medium" },
      }),
      "Base Cursor prompt",
      3
    );

    expect(runtime.runtimeType).toBe("cursor-sdk");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "cursor-test-key",
      model: {
        id: "grok-4.5",
        params: [
          { id: "effort", value: "medium" },
          { id: "fast", value: "true" },
        ],
      },
    }));
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
    }), "Base Cursor prompt", 3)).rejects.toThrow(/Cursor SDK auth/);
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

});
