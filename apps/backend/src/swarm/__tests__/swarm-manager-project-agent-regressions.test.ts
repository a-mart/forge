import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import {
  getProfileMemoryPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
  getProjectAgentReferenceDir
} from "../data-paths.js";
import { readProjectAgentRecord } from "../project-agent-storage.js";
import { SwarmManager } from "../swarm-manager.js";
import type { RuntimeUserMessage, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentContextUsage, AgentDescriptor, RequestedDeliveryMode, SendMessageReceipt, SwarmConfig } from "../types.js";
import { bootWithDefaultManager as bootWithDefaultManagerFromSupport } from "../../test-support/index.js";

class FakeRuntime {
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = [];

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
    message: string | RuntimeUserMessage,
    delivery: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery });
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
  readonly runtimeByAgentId = new Map<string, FakeRuntime>();

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    _runtimeToken?: number
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(systemPrompt);
    this.runtimeByAgentId.set(descriptor.agentId, runtime);
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
  return bootWithDefaultManagerFromSupport(manager, config, {
    callerAgentId: "bootstrap",
    clearBootstrapSendCalls: false
  });
}

describe("SwarmManager project-agent regressions", () => {
  it("strips systemPrompt from cloned descriptors, list snapshots, and update events", async () => {
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

    // systemPrompt intentionally omitted from cloned output — fetched via get_project_agent_config
    expect(manager.getAgent(target.agentId)?.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Draft release notes",
    });

    expect(manager.listAgents().find((agent) => agent.agentId === target.agentId)?.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Draft release notes",
    });

    expect(sessionProjectAgentUpdatedEvents.at(-1)?.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Draft release notes",
    });

    // Internal descriptor still has systemPrompt (for agents.json persistence)
    const state = manager as unknown as { descriptors: Map<string, import("../../swarm/types.js").AgentDescriptor> };
    expect(state.descriptors.get(target.agentId)?.projectAgent?.systemPrompt).toBe("You own release-note drafting.");
  });

  it("keeps the project-agent mutation applied when saveStore fails after the on-disk write", async () => {
    const config = await makeTempConfig(8899);
    const manager = new TestSwarmManager(config);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rootManager = await bootWithDefaultManager(manager, config);
    const target = await manager.createManager(rootManager.agentId, {
      name: "docs",
      cwd: config.defaultCwd
    });

    vi.spyOn(manager as unknown as { saveStore: () => Promise<void> }, "saveStore").mockRejectedValueOnce(new Error("save boom"));

    const result = await manager.setSessionProjectAgent(target.agentId, {
      handle: "docs",
      whenToUse: "Maintain docs",
      systemPrompt: "Document the system."
    });

    expect(result.projectAgent).toEqual({
      handle: "docs",
      whenToUse: "Maintain docs"
    });
    expect(manager.getAgent(target.agentId)?.projectAgent).toEqual({
      handle: "docs",
      whenToUse: "Maintain docs"
    });

    const record = await readProjectAgentRecord(config.paths.dataDir, target.profileId!, "docs");
    expect(record?.config.agentId).toBe(target.agentId);
    expect(record?.systemPrompt).toBe("Document the system.");

    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as { agents: AgentDescriptor[] };
    expect(store.agents.find((agent) => agent.agentId === target.agentId)?.projectAgent).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("project-agent-storage:post_commit_sync_failed"));
  });

  it("rejects changing a project-agent handle after promotion", async () => {
    const config = await makeTempConfig(8900);
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

    const referenceDir = getProjectAgentReferenceDir(config.paths.dataDir, target.profileId!, "docs");
    const referencePath = join(referenceDir, "notes.md");
    await mkdir(referenceDir, { recursive: true });
    await writeFile(referencePath, "reference notes", "utf8");

    await expect(
      manager.setSessionProjectAgent(target.agentId, {
        handle: "documentation",
        whenToUse: "Maintain docs",
        systemPrompt: "Document the system better."
      })
    ).rejects.toThrow("Cannot change project agent handle after promotion. Demote and re-promote to change the handle.");

    await expect(access(getProjectAgentDir(config.paths.dataDir, target.profileId!, "docs"))).resolves.toBeUndefined();
    await expect(access(getProjectAgentDir(config.paths.dataDir, target.profileId!, "documentation"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(referencePath, "utf8")).resolves.toBe("reference notes");
    expect(manager.getAgent(target.agentId)?.projectAgent?.handle).toBe("docs");
  });

  it("scopes project-agent fire-and-forget delivery limits to the sending session across targets", async () => {
    const config = await makeTempConfig(8901);
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent: docsAgent } = await manager.createSession("manager", { label: "Docs" });
    const { sessionAgent: qaAgent } = await manager.createSession("manager", { label: "QA" });
    const { sessionAgent: secondSender } = await manager.createSession("manager", { label: "Ops" });

    await manager.setSessionProjectAgent(docsAgent.agentId, {
      handle: "docs",
      whenToUse: "Maintain docs",
      systemPrompt: "Document the system."
    });
    await manager.setSessionProjectAgent(qaAgent.agentId, {
      handle: "qa",
      whenToUse: "Reproduce issues",
      systemPrompt: "Reproduce the bug."
    });

    const deliveryReceipts: SendMessageReceipt[] = [];
    for (let index = 0; index < 6; index += 1) {
      const targetAgentId = index % 2 === 0 ? docsAgent.agentId : qaAgent.agentId;
      deliveryReceipts.push(await manager.sendMessage("manager", targetAgentId, `note-${index + 1}`, "auto"));
    }

    expect(deliveryReceipts).toHaveLength(6);
    expect(deliveryReceipts.every((receipt) => receipt.acceptedMode === "prompt")).toBe(true);

    await expect(
      manager.sendMessage("manager", docsAgent.agentId, "note-7", "auto")
    ).rejects.toThrow(
      "Project-agent messaging rate limit exceeded for this session. Batch your message or involve the user before continuing."
    );

    const independentReceipt = await manager.sendMessage(secondSender.agentId, docsAgent.agentId, "ops-follow-up", "auto");
    expect(independentReceipt.acceptedMode).toBe("prompt");

    const docsRuntime = manager.runtimeByAgentId.get(docsAgent.agentId);
    const qaRuntime = manager.runtimeByAgentId.get(qaAgent.agentId);
    expect(docsRuntime?.sendCalls.map((call) => call.message)).toEqual([
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: "manager",
        fromDisplayName: "manager"
      })}\n\nnote-1`,
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: "manager",
        fromDisplayName: "manager"
      })}\n\nnote-3`,
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: "manager",
        fromDisplayName: "manager"
      })}\n\nnote-5`,
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: secondSender.agentId,
        fromDisplayName: "Ops"
      })}\n\nops-follow-up`
    ]);
    expect(qaRuntime?.sendCalls.map((call) => call.message)).toEqual([
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: "manager",
        fromDisplayName: "manager"
      })}\n\nnote-2`,
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: "manager",
        fromDisplayName: "manager"
      })}\n\nnote-4`,
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: "manager",
        fromDisplayName: "manager"
      })}\n\nnote-6`
    ]);
  });

  it("treats an empty prompt.md as an intentionally blank override instead of falling back to descriptor cache", async () => {
    const config = await makeTempConfig(8902);
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
