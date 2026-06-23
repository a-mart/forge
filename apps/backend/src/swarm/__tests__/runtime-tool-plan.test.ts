import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import {
  buildBaseRuntimeTools,
  planForgePiToolBridgeFactory,
  planPiExtensionFactories,
  planRuntimeTools
} from "../runtime/runtime-tool-plan.js";
import { resolvePiActiveToolNamesForDescriptor } from "../runtime/pi/pi-runtime-creator.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

function createHost(): SwarmToolHost {
  return {
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
    runTaskTool: async () => ({
      action: "get",
      stateRevision: 0,
      snapshot: {
        sessionAgentId: "manager-1",
        profileId: "profile-1",
        revision: 0,
        activeWorkPlan: null,
        recentWorkPlans: [],
        recentWorkPlanCount: 0,
        recentWorkPlansTruncated: false,
      },
    }),
  } as SwarmToolHost;
}

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

function createDescriptor(rootDir: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
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

function toolNames(descriptor: AgentDescriptor): string[] {
  return buildBaseRuntimeTools(createHost(), descriptor).map((tool) => tool.name);
}

afterEach(() => {
  delete process.env.FORGE_DEBUG;
});

describe("runtime tool plan", () => {
  it("plans worker and manager base tool sets deterministically", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));

    expect(toolNames(createDescriptor(rootDir))).toEqual([
      "list_agents",
      "send_message_to_agent",
    ]);
    expect(toolNames(createManagerDescriptor(rootDir))).toEqual([
      "list_agents",
      "send_message_to_agent",
      "spawn_agent",
      "retry_codex_plugin_worker",
      "kill_agent",
      "speak_to_user",
      "present_choices",
    ]);
  });

  it("drops Pi default coding tools for scoped Codex Plugin specialist workers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));
    const descriptor = createDescriptor(rootDir, {
      agentId: "codex-plugin-fireflies",
      internalWorkerKind: "codex_plugin",
    });

    expect(
      resolvePiActiveToolNamesForDescriptor(
        descriptor,
        ["read", "bash", "edit", "write", "list_agents"],
        ["send_message_to_agent", "list_scoped_codex_plugin_tools", "codex_fireflies_list_recent"],
      ).sort(),
    ).toEqual([
      "codex_fireflies_list_recent",
      "list_scoped_codex_plugin_tools",
      "send_message_to_agent",
    ]);
  });

  it("adds create_session for capable project agents", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));
    const names = toolNames(createManagerDescriptor(rootDir, {
      projectAgent: {
        handle: "notes",
        whenToUse: "Draft notes",
        capabilities: ["create_session"],
      },
    }));

    expect(names).toContain("create_session");
    expect(names).not.toContain("create_project_agent");
  });

  it("adds create_project_agent for Agent Creator sessions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));

    expect(toolNames(createManagerDescriptor(rootDir, { sessionPurpose: "agent_creator" }))).toContain(
      "create_project_agent"
    );
  });

  it("filters unsafe agent-management tools for Cortex", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));
    const names = toolNames(createManagerDescriptor(rootDir, { archetypeId: "cortex" }));

    expect(names).not.toContain("list_agents");
    expect(names).not.toContain("kill_agent");
    expect(names).not.toContain("task");
    expect(names).toContain("spawn_agent");
  });

  it("uses base swarm tool names for the Forge Pi bridge skip list before wrapping", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));
    const descriptor = createManagerDescriptor(rootDir, { sessionPurpose: "agent_creator" });
    const forgeExtensionHost = new ForgeExtensionHost({
      dataDir: join(rootDir, "data"),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const plan = planRuntimeTools({
      host: createHost(),
      descriptor,
      forgeExtensionHost,
      preparedForgeBindings: null,
    });
    const dispatchToolBefore = vi.fn(async () => undefined);
    const bridgeFactory = planForgePiToolBridgeFactory({
      forgeExtensionHost: { dispatchToolBefore } as unknown as ForgeExtensionHost,
      preparedForgeBindings: {
        bindingToken: "binding-1",
      } as any,
      baseSwarmTools: plan.baseSwarmTools,
    });
    const handlers = new Map<string, (event: any) => Promise<unknown>>();

    bridgeFactory?.({
      on: (event: string, handler: (toolEvent: any) => Promise<unknown>) => {
        handlers.set(event, handler);
      },
    } as any);

    expect(plan.baseSwarmTools.map((tool) => tool.name)).toContain("create_project_agent");
    await handlers.get("tool_call")?.({ toolName: "create_project_agent", toolCallId: "tool-1", input: {} });
    await handlers.get("tool_call")?.({ toolName: "user_extension_tool", toolCallId: "tool-2", input: {} });

    expect(dispatchToolBefore).toHaveBeenCalledTimes(1);
    expect(dispatchToolBefore).toHaveBeenCalledWith("binding-1", expect.objectContaining({
      toolName: "user_extension_tool",
    }));
  });
});

describe("runtime Pi extension factory plan", () => {
  it("preserves pinned, debug, Forge bridge, catalog request behavior ordering", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-runtime-tool-plan-"));
    await mkdir(rootDir, { recursive: true });
    process.env.FORGE_DEBUG = "true";
    const bridgeFactory = vi.fn((pi: any) => pi.on("forge_bridge", () => undefined));
    const factories = planPiExtensionFactories({
      descriptor: createManagerDescriptor(rootDir, {
        model: {
          provider: "xai",
          modelId: "grok-4",
          thinkingLevel: "high",
        },
      }),
      config: createConfig(rootDir),
      logDebug: vi.fn(),
      forgePiToolBridgeFactory: bridgeFactory,
    });
    const registeredEvents: string[] = [];

    for (const factory of factories) {
      factory({
        on: (event: string) => {
          registeredEvents.push(event);
        },
      } as any);
    }

    expect(registeredEvents).toEqual([
      "session_before_compact",
      "tool_call",
      "forge_bridge",
      "before_provider_request",
    ]);
  });
});
