import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { getProfileMemoryPath } from "../data-paths.js";
import { SwarmManager } from "../swarm-manager.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-types.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig
} from "../types.js";

class FakeClaudeRuntime {
  readonly runtimeType = "claude" as const;

  recycleCalls = 0;

  constructor(
    readonly descriptor: AgentDescriptor,
    private readonly systemPrompt: string
  ) {}

  getStatus(): AgentDescriptor["status"] {
    return "idle";
  }

  getPendingCount(): number {
    return 0;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  async sendMessage(
    _message: string | RuntimeUserMessage,
    _delivery: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: "unused",
      acceptedMode: "prompt"
    };
  }

  async compact(): Promise<unknown> {
    return { status: "ok" };
  }

  async smartCompact(): Promise<unknown> {
    return { status: "ok" };
  }

  async stopInFlight(): Promise<void> {}

  async terminate(): Promise<void> {}

  async recycle(): Promise<void> {
    this.recycleCalls += 1;
  }

  getCustomEntries(): unknown[] {
    return [];
  }

  appendCustomEntry(): string {
    return "unused";
  }

  isContextRecoveryInProgress(): boolean {
    return false;
  }
}

class TestSwarmManager extends SwarmManager {
  private readonly fakeRuntimes = new Map<string, FakeClaudeRuntime>();

  getFakeRuntime(agentId: string): FakeClaudeRuntime | undefined {
    return this.fakeRuntimes.get(agentId);
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    _runtimeToken?: number
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeClaudeRuntime(descriptor, systemPrompt);
    this.fakeRuntimes.set(descriptor.agentId, runtime);
    return runtime as unknown as SwarmAgentRuntime;
  }

  protected override async executeSessionMemoryLLMMerge(): Promise<{ mergedContent: string; model: string }> {
    throw new Error("LLM merge disabled in tests");
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempConfig(port = 8901): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "claude-session-lifecycle-"));
  tempRoots.push(root);

  const dataDir = join(root, "data");
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "sessions");
  const uploadsDir = join(dataDir, "uploads");
  const profilesDir = join(dataDir, "profiles");
  const sharedDir = join(dataDir, "shared");
  const sharedConfigDir = join(sharedDir, "config");
  const sharedCacheDir = join(sharedDir, "cache");
  const sharedStateDir = join(sharedDir, "state");
  const sharedAuthDir = join(sharedConfigDir, "auth");
  const sharedAuthFile = join(sharedAuthDir, "auth.json");
  const sharedSecretsFile = join(sharedConfigDir, "secrets.json");
  const sharedIntegrationsDir = join(sharedConfigDir, "integrations");
  const authDir = join(dataDir, "auth");
  const agentDir = join(dataDir, "agent");
  const managerAgentDir = join(agentDir, "manager");
  const repoArchetypesDir = join(root, ".swarm", "archetypes");
  const memoryDir = join(dataDir, "memory");
  const memoryFile = getProfileMemoryPath(dataDir, "manager");
  const repoMemorySkillFile = join(root, ".swarm", "skills", "memory", "SKILL.md");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await mkdir(sharedAuthDir, { recursive: true });
  await mkdir(sharedIntegrationsDir, { recursive: true });
  await mkdir(sharedCacheDir, { recursive: true });
  await mkdir(sharedStateDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(managerAgentDir, { recursive: true });
  await mkdir(repoArchetypesDir, { recursive: true });

  return {
    host: "127.0.0.1",
    port,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "claude-sdk",
      modelId: "claude-sonnet-4.5",
      thinkingLevel: "medium"
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, "worktrees")],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, "agents.json"),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, "manager")
    }
  };
}

async function bootWithDefaultManager(manager: TestSwarmManager, config: SwarmConfig): Promise<AgentDescriptor> {
  await manager.boot();

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === config.managerId && descriptor.role === "manager"
  );
  if (existingManager) {
    return existingManager;
  }

  return manager.createManager("bootstrap", {
    name: config.managerDisplayName ?? config.managerId ?? "manager",
    cwd: config.defaultCwd
  });
}

describe("Claude session lifecycle", () => {
  it("recycles active Claude runtimes when clearing a conversation", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    const rootManager = await bootWithDefaultManager(manager, config);
    const session = await manager.createManager(rootManager.agentId, {
      name: "Claude Session",
      cwd: config.defaultCwd
    });

    const runtime = manager.getFakeRuntime(session.agentId);
    expect(runtime).toBeDefined();

    await writeFile(session.sessionFile, "stale transcript", "utf8");
    await manager.clearSessionConversation(session.agentId);

    expect(runtime?.recycleCalls).toBe(1);
    await expect(readFile(session.sessionFile, "utf8")).resolves.toBe("");
  });

  it("drops persisted Claude runtime state when forking a full session", async () => {
    const config = await makeTempConfig(8902);
    const manager = new TestSwarmManager(config);
    const rootManager = await bootWithDefaultManager(manager, config);
    const source = await manager.createManager(rootManager.agentId, {
      name: "Claude Source",
      cwd: config.defaultCwd
    });

    await writeFile(
      source.sessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "hdr", timestamp: "2026-01-01T00:00:00.000Z", cwd: config.defaultCwd }),
        JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id: "m1", data: { id: "m1" } }),
        JSON.stringify({ type: "custom", customType: "swarm_claude_session_state", data: { claudeSessionId: "claude-parent", generationId: 0, lastCheckpointAt: "2026-01-01T00:00:01.000Z" } }),
        JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id: "m2", data: { id: "m2" } }),
        ""
      ].join("\n"),
      "utf8"
    );

    const forked = await manager.forkSession(source.agentId, { label: "Forked" });
    const forkedContent = await readFile(forked.sessionAgent.sessionFile, "utf8");

    expect(forkedContent).toContain('"id":"m1"');
    expect(forkedContent).toContain('"id":"m2"');
    expect(forkedContent).not.toContain("swarm_claude_session_state");
  });

  it("drops persisted Claude runtime state when partially forking a session", async () => {
    const config = await makeTempConfig(8903);
    const manager = new TestSwarmManager(config);
    const rootManager = await bootWithDefaultManager(manager, config);
    const source = await manager.createManager(rootManager.agentId, {
      name: "Claude Source",
      cwd: config.defaultCwd
    });

    await writeFile(
      source.sessionFile,
      [
        JSON.stringify({ type: "session", version: 3, id: "hdr", timestamp: "2026-01-01T00:00:00.000Z", cwd: config.defaultCwd }),
        JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id: "m1", data: { id: "m1" } }),
        JSON.stringify({ type: "custom", customType: "swarm_claude_session_state", data: { claudeSessionId: "claude-parent", generationId: 0, lastCheckpointAt: "2026-01-01T00:00:01.000Z" } }),
        JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id: "m2", data: { id: "m2" } }),
        JSON.stringify({ type: "custom", customType: "swarm_conversation_entry", id: "m3", data: { id: "m3" } }),
        ""
      ].join("\n"),
      "utf8"
    );

    const forked = await manager.forkSession(source.agentId, {
      label: "Forked Partial",
      fromMessageId: "m2"
    });
    const forkedContent = await readFile(forked.sessionAgent.sessionFile, "utf8");

    expect(forkedContent).toContain('"id":"m1"');
    expect(forkedContent).toContain('"id":"m2"');
    expect(forkedContent).not.toContain('"id":"m3"');
    expect(forkedContent).not.toContain("swarm_claude_session_state");
  });
});
