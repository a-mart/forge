import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime } from "../runtime-contracts.js";
import { getSessionTasksPath } from "../storage/data-paths.js";
import { createEmptySessionCoordinationState, type WorkPlanRecord } from "../coordination/session-coordination-state.js";
import { transitionSessionWorkPlansForLifecycle } from "../coordination/work-plan-lifecycle.js";
import { makeTempConfig as buildTempConfig, FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from "../../test-support/index.js";

const FIXED_TIMESTAMP = "2026-05-29T12:00:00.000Z";

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
    (runtime as FakeRuntime).terminateMutatesDescriptorStatus = false;
    return runtime;
  }
}

async function makeTempConfig(port = 8890): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: "work-plan-lifecycle-",
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  });
}

describe("Active Work Plan lifecycle", () => {
  it("returns unavailable when lifecycle transition cannot read the sidecar", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Unavailable Direct" });
    await makeTasksPathUnreadable(config, sessionAgent.agentId);

    await expect(
      transitionSessionWorkPlansForLifecycle({
        dataDir: config.paths.dataDir,
        profileId: "manager",
        sessionAgentId: sessionAgent.agentId,
        actorAgentId: sessionAgent.agentId,
        reason: "manual_stop",
      }),
    ).resolves.toBe("unavailable");
  });

  it("leaves active work sidecar unchanged on manual session stop while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Stop Target" });
    await writeTasksFile(config, sessionAgent.agentId, [createPlan("Active stop plan")]);

    await manager.stopSession(sessionAgent.agentId);

    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
          items: [{ itemId: "item-active", status: "active" }],
        },
      ],
    });
  });

  it("leaves active work sidecar unchanged on stop-all while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    await writeTasksFile(config, "manager", [createPlan("Root active plan")]);

    await manager.stopAllAgents("manager", "manager");

    await expect(readTasksFile(config, "manager")).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
          items: [{ itemId: "item-active", status: "active" }],
        },
      ],
    });
  });

  it("preserves the sidecar without interrupting active work when clearing a session conversation while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Clear Target" });
    await writeTasksFile(config, sessionAgent.agentId, [createPlan("Plan to clear")]);

    await manager.clearSessionConversation(sessionAgent.agentId);

    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
          items: [{ itemId: "item-active", status: "active" }],
        },
      ],
    });
  });

  it("preserves the sidecar without archive transitions after session archive and restore while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Archive Target" });
    await writeTasksFile(config, sessionAgent.agentId, [createPlan("Plan to archive")]);

    await manager.archiveSession(sessionAgent.agentId);
    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
        },
      ],
    });

    await manager.restoreSession(sessionAgent.agentId);
    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
        },
      ],
    });
  });

  it("preserves child session sidecars unchanged across project archive and restore while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Project Archive Target" });
    await writeTasksFile(config, sessionAgent.agentId, [createPlan("Plan in archived project")]);

    await manager.archiveProfile("manager");
    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
        },
      ],
    });

    await manager.restoreProfile("manager");
    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toMatchObject({
      workPlans: [
        {
          planId: "plan-active",
          status: "active",
        },
      ],
    });
  });

  it("does not read or rebroadcast task snapshots for stop, clear, and archive lifecycle paths while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const runCase = async (
      label: string,
      action: (sessionAgentId: string) => Promise<void>,
    ) => {
      const { sessionAgent } = await manager.createSession("manager", { label });
      await makeTasksPathUnreadable(config, sessionAgent.agentId);
      const snapshots: Array<Record<string, unknown>> = [];
      manager.on("session_task_state_snapshot", (event: Record<string, unknown>) => {
        if (event.sessionAgentId === sessionAgent.agentId) {
          snapshots.push(event);
        }
      });

      await action(sessionAgent.agentId);

      expect(snapshots).toHaveLength(0);
    };

    await runCase("Unavailable Stop", (sessionAgentId) => manager.stopSession(sessionAgentId));
    await runCase("Unavailable Clear", (sessionAgentId) => manager.clearSessionConversation(sessionAgentId));
    await runCase("Unavailable Archive", (sessionAgentId) => manager.archiveSession(sessionAgentId));
  });

  it("does not copy task sidecars on full or partial fork while parked", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Fork Source" });
    await seedForkableConversation(config, sessionAgent);
    await writeTasksFile(config, sessionAgent.agentId, [
      createPlan("Active plan that must not leak"),
      createPlan("Completed summary", {
        planId: "plan-terminal",
        createdByAgentId: "source-manager",
        status: "completed_with_warnings",
        completedAt: FIXED_TIMESTAMP,
        updatedAt: FIXED_TIMESTAMP,
        goal: "Do not leak this source goal into fork metadata",
        finalSummary: "Terminal summary copied safely.",
        warnings: ["One warning"],
        items: [
          {
            itemId: "item-terminal",
            title: "Terminal detail that should be dropped",
            status: "done",
            workerLinks: [
              {
                type: "worker",
                linkId: "link-source",
                agentId: "worker-source",
                label: "Source worker",
                specialistId: "backend-specialist",
                linkedAt: FIXED_TIMESTAMP,
              },
            ],
            createdAt: FIXED_TIMESTAMP,
            updatedAt: FIXED_TIMESTAMP,
          },
        ],
        revisionNotes: [{ revision: 2, note: "Internal terminal note", createdAt: FIXED_TIMESTAMP }],
        mutationProvenance: [
          {
            action: "finish_plan",
            actorAgentId: "worker-source",
            mutatedAt: FIXED_TIMESTAMP,
            toolCallId: "tool-source",
          },
        ],
      }),
    ]);

    const fullFork = await manager.forkSession(sessionAgent.agentId, { label: "Full Fork" });
    await expect(readTasksFile(config, fullFork.sessionAgent.agentId)).resolves.toBeNull();

    const partialFork = await manager.forkSession(sessionAgent.agentId, {
      label: "Partial Fork",
      fromMessageId: "m2",
    });
    await expect(readTasksFile(config, partialFork.sessionAgent.agentId)).resolves.toBeNull();
  });

  it("removes the sidecar when deleting a session", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);

    const { sessionAgent } = await manager.createSession("manager", { label: "Delete Target" });
    await writeTasksFile(config, sessionAgent.agentId, [createPlan("Plan to delete")]);

    await manager.deleteSession(sessionAgent.agentId);

    await expect(readTasksFile(config, sessionAgent.agentId)).resolves.toBeNull();
  });
});

function createPlan(title: string, overrides: Partial<WorkPlanRecord> = {}): WorkPlanRecord {
  return {
    planId: overrides.planId ?? "plan-active",
    createdByAgentId: overrides.createdByAgentId ?? "manager",
    title,
    ...(overrides.goal === undefined ? {} : { goal: overrides.goal }),
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? FIXED_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FIXED_TIMESTAMP,
    ...(overrides.completedAt === undefined ? {} : { completedAt: overrides.completedAt }),
    revision: overrides.revision ?? 1,
    items: overrides.items ?? [
      {
        itemId: "item-active",
        title: "Investigate lifecycle",
        status: "active",
        workerLinks: [],
        createdAt: FIXED_TIMESTAMP,
        updatedAt: FIXED_TIMESTAMP,
      },
    ],
    revisionNotes: overrides.revisionNotes ?? [],
    warnings: overrides.warnings ?? [],
    ...(overrides.finalSummary === undefined ? {} : { finalSummary: overrides.finalSummary }),
    ...(overrides.lifecycle === undefined ? {} : { lifecycle: overrides.lifecycle }),
    mutationProvenance: overrides.mutationProvenance ?? [],
  };
}

async function makeTasksPathUnreadable(config: SwarmConfig, sessionAgentId: string): Promise<void> {
  const filePath = getSessionTasksPath(config.paths.dataDir, "manager", sessionAgentId);
  await mkdir(filePath, { recursive: true });
}

async function writeTasksFile(config: SwarmConfig, sessionAgentId: string, workPlans: WorkPlanRecord[]): Promise<void> {
  const filePath = getSessionTasksPath(config.paths.dataDir, "manager", sessionAgentId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    ...createEmptySessionCoordinationState(),
    revision: 1,
    updatedAt: FIXED_TIMESTAMP,
    workPlans,
  }, null, 2)}\n`, "utf8");
}

async function readTasksFile(config: SwarmConfig, sessionAgentId: string): Promise<Record<string, unknown> | null> {
  const filePath = getSessionTasksPath(config.paths.dataDir, "manager", sessionAgentId);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function seedForkableConversation(config: SwarmConfig, sessionAgent: AgentDescriptor): Promise<void> {
  await writeFile(
    sessionAgent.sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "hdr",
        timestamp: FIXED_TIMESTAMP,
        cwd: config.defaultCwd,
      }),
      JSON.stringify({
        type: "custom",
        customType: "swarm_conversation_entry",
        id: "entry-1",
        parentId: null,
        timestamp: FIXED_TIMESTAMP,
        data: {
          type: "conversation_message",
          id: "m1",
          agentId: sessionAgent.agentId,
          role: "assistant",
          text: "Before partial fork boundary",
          timestamp: FIXED_TIMESTAMP,
          source: "system",
        },
      }),
      JSON.stringify({
        type: "custom",
        customType: "swarm_conversation_entry",
        id: "entry-2",
        parentId: "entry-1",
        timestamp: FIXED_TIMESTAMP,
        data: {
          type: "conversation_message",
          id: "m2",
          agentId: sessionAgent.agentId,
          role: "assistant",
          text: "Partial fork boundary",
          timestamp: FIXED_TIMESTAMP,
          source: "system",
        },
      }),
      JSON.stringify({
        type: "custom",
        customType: "swarm_conversation_entry",
        id: "entry-3",
        parentId: "entry-2",
        timestamp: FIXED_TIMESTAMP,
        data: {
          type: "conversation_message",
          id: "m3",
          agentId: sessionAgent.agentId,
          role: "assistant",
          text: "After partial fork boundary",
          timestamp: FIXED_TIMESTAMP,
          source: "system",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
}
