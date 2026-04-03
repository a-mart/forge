import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { getProfileMemoryPath, getProjectAgentDir, getProjectAgentPromptPath } from "../data-paths.js";
import { readProjectAgentRecord } from "../project-agent-storage.js";
import { SwarmManager } from "../swarm-manager.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-types.js";
import type { AgentContextUsage, AgentDescriptor, RequestedDeliveryMode, SendMessageReceipt, SwarmConfig } from "../types.js";

class FakeRuntime {
  constructor(private readonly systemPrompt: string) {}

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
      targetAgentId: "unused",
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

  async recycle(): Promise<void> {}

  isContextRecoveryInProgress(): boolean {
    return false;
  }
}

class TestSwarmManager extends SwarmManager {
  protected override async createRuntimeForDescriptor(
    _descriptor: AgentDescriptor,
    systemPrompt: string,
    _runtimeToken?: number
  ): Promise<SwarmAgentRuntime> {
    return new FakeRuntime(systemPrompt) as unknown as SwarmAgentRuntime;
  }

  protected override async executeSessionMemoryLLMMerge(): Promise<{ mergedContent: string; model: string }> {
    throw new Error("LLM merge disabled in tests");
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempConfig(port = 8898): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "swarm-manager-project-agent-regressions-"));
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

describe("SwarmManager project-agent regressions", () => {
  it("keeps systemPrompt in cloned descriptors, list snapshots, and update events", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    const sessionProjectAgentUpdatedEvents: any[] = [];
    manager.on("session_project_agent_updated", (event) => {
      sessionProjectAgentUpdatedEvents.push(event);
    });

    const rootManager = await bootWithDefaultManager(manager, config);
    const target = await manager.createManager(rootManager.agentId, {
      name: "release-notes",
      cwd: config.defaultCwd
    });

    await manager.setSessionProjectAgent(target.agentId, {
      handle: "release-notes",
      whenToUse: "Draft release notes",
      systemPrompt: "You own release-note drafting."
    });

    expect(manager.getAgent(target.agentId)?.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Draft release notes",
      systemPrompt: "You own release-note drafting."
    });

    expect(manager.listAgents().find((agent) => agent.agentId === target.agentId)?.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Draft release notes",
      systemPrompt: "You own release-note drafting."
    });

    expect(sessionProjectAgentUpdatedEvents.at(-1)?.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Draft release notes",
      systemPrompt: "You own release-note drafting."
    });
  });

  it("renames the on-disk project-agent record when the handle changes", async () => {
    const config = await makeTempConfig(8899);
    const manager = new TestSwarmManager(config);
    const rootManager = await bootWithDefaultManager(manager, config);
    const target = await manager.createManager(rootManager.agentId, {
      name: "docs",
      cwd: config.defaultCwd
    });

    await manager.setSessionProjectAgent(target.agentId, {
      handle: "docs",
      whenToUse: "Maintain docs",
      systemPrompt: "Document the system."
    });
    await manager.setSessionProjectAgent(target.agentId, {
      handle: "documentation",
      whenToUse: "Maintain docs",
      systemPrompt: "Document the system better."
    });

    await expect(access(getProjectAgentDir(config.paths.dataDir, target.profileId!, "docs"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      readFile(getProjectAgentPromptPath(config.paths.dataDir, target.profileId!, "documentation"), "utf8")
    ).resolves.toBe("Document the system better.");

    const record = await readProjectAgentRecord(config.paths.dataDir, target.profileId!, "documentation");
    expect(record?.config.handle).toBe("documentation");
    expect(record?.systemPrompt).toBe("Document the system better.");
    expect(manager.getAgent(target.agentId)?.projectAgent?.handle).toBe("documentation");
  });

  it("treats an empty prompt.md as an intentionally blank override instead of falling back to descriptor cache", async () => {
    const config = await makeTempConfig(8900);
    const manager = new TestSwarmManager(config);
    const rootManager = await bootWithDefaultManager(manager, config);
    const target = await manager.createManager(rootManager.agentId, {
      name: "qa",
      cwd: config.defaultCwd
    });

    await manager.setSessionProjectAgent(target.agentId, {
      handle: "qa",
      whenToUse: "Reproduce issues",
      systemPrompt: "Descriptor mirror prompt"
    });

    const promptPath = getProjectAgentPromptPath(config.paths.dataDir, target.profileId!, "qa");
    await writeFile(promptPath, "", "utf8");

    const descriptor = manager.getAgent(target.agentId)!;
    const resolved = await (manager as any).resolveProjectAgentSystemPromptOverride(descriptor);

    expect(resolved).toEqual({
      prompt: undefined,
      sourcePath: undefined
    });
    await expect(readFile(promptPath, "utf8")).resolves.toBe("");
  });
});
