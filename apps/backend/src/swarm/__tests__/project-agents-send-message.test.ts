import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { getProfileMemoryPath } from "../data-paths.js";
import { getConversationHistoryCacheFilePath } from "../conversation-history-cache.js";
import { SwarmManager } from "../swarm-manager.js";
import type { AgentContextUsage, AgentDescriptor, RequestedDeliveryMode, SendMessageReceipt, SwarmConfig } from "../types.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-types.js";

class FakeRuntime {
  readonly descriptor: AgentDescriptor;
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = [];
  private nextDeliveryId = 0;
  private readonly sessionManager: SessionManager;

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor;
    this.sessionManager = SessionManager.open(descriptor.sessionFile);
  }

  getStatus(): AgentDescriptor["status"] {
    return this.descriptor.status;
  }

  getPendingCount(): number {
    return 0;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined;
  }

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery });
    this.nextDeliveryId += 1;

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
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

  async recycle(): Promise<void> {}

  isContextRecoveryInProgress(): boolean {
    return false;
  }

  getCustomEntries(customType: string): unknown[] {
    return this.sessionManager.getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === customType)
      .map((entry) => (entry.type === "custom" ? entry.data : undefined))
      .filter((entry) => entry !== undefined);
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.sessionManager.appendCustomEntry(customType, data);
  }
}

class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>();

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    _systemPrompt: string,
    _runtimeToken?: number
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor);
    this.runtimeByAgentId.set(descriptor.agentId, runtime);
    return runtime as unknown as SwarmAgentRuntime;
  }

  protected override async executeSessionMemoryLLMMerge(): Promise<{ mergedContent: string; model: string }> {
    throw new Error("LLM merge disabled in tests");
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempConfig(port = 8897): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "project-agents-send-message-test-"));
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
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
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

async function waitForFileText(
  path: string,
  options?: { timeoutMs?: number; matches?: (text: string) => boolean }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      if (!options?.matches || options.matches(text)) {
        return text;
      }
    } catch {
      // keep polling until the cache write lands
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for file ${path}`);
}

describe("SwarmManager project-agent sendMessage routing", () => {
  it("uses the generic path for cross-profile manager sends to promoted targets", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);

    const sender = await bootWithDefaultManager(manager, config);
    const target = await manager.createManager(sender.agentId, {
      name: "beta",
      cwd: config.defaultCwd
    });

    await manager.setSessionProjectAgent(target.agentId, {
      whenToUse: "Draft release notes"
    });

    const receipt = await manager.sendMessage(sender.agentId, target.agentId, "Cross-profile ping", "auto");
    const targetRuntime = manager.runtimeByAgentId.get(target.agentId);

    expect(receipt).toMatchObject({
      targetAgentId: target.agentId,
      acceptedMode: "prompt"
    });
    expect(targetRuntime?.sendCalls).toHaveLength(1);
    expect(targetRuntime?.sendCalls[0]).toEqual({
      message: "SYSTEM: Cross-profile ping",
      delivery: "auto"
    });

    const targetHistory = manager.getConversationHistory(target.agentId);
    expect(
      targetHistory.filter(
        (entry) => entry.type === "conversation_message" && entry.source === "project_agent_input"
      )
    ).toEqual([]);
  });

  it("preserves dormant same-profile project-agent history when an async message lands before lazy load", async () => {
    const config = await makeTempConfig(8898);
    const firstBoot = new TestSwarmManager(config);

    const sender = await bootWithDefaultManager(firstBoot, config);
    const { sessionAgent: target } = await firstBoot.createSession(sender.profileId ?? sender.agentId, {
      label: "Release Notes"
    });

    await firstBoot.setSessionProjectAgent(target.agentId, {
      whenToUse: "Draft release notes"
    });

    const seededSession = SessionManager.open(target.sessionFile);
    seededSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed message" }]
    } as never);
    seededSession.appendCustomEntry("swarm_conversation_entry", {
      type: "conversation_message",
      agentId: target.agentId,
      role: "assistant",
      text: "persisted history before async delivery",
      timestamp: "2025-12-31T23:58:00.000Z",
      source: "system"
    });

    const secondBoot = new TestSwarmManager(config);
    await secondBoot.boot();

    await secondBoot.sendMessage(sender.agentId, target.agentId, "Need a release summary", "auto");

    const cacheFile = getConversationHistoryCacheFilePath(target.sessionFile);
    await waitForFileText(cacheFile, {
      matches: (text) =>
        text.includes("persisted history before async delivery") && text.includes("Need a release summary")
    });

    const thirdBoot = new TestSwarmManager(config);
    await thirdBoot.boot();

    const history = thirdBoot.getConversationHistory(target.agentId);
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" && entry.text === "persisted history before async delivery"
      )
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.source === "project_agent_input" &&
          entry.text === "Need a release summary"
      )
    ).toBe(true);
  });
});
