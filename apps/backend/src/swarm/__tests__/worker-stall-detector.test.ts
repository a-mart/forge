import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { getProfileMemoryPath } from "../data-paths.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import { TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";

async function makeTempConfig(port = 8896): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "worker-stall-detector-test-"));
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

type StallStateSnapshot = {
  lastProgressAt: number;
  nudgeSent: boolean;
  nudgeSentAt: number | null;
  lastToolName: string | null;
  lastToolInput: string | null;
  lastToolOutput: string | null;
  lastDetailedReportAt: number | null;
};

async function setupManagerWithStreamingWorker() {
  const config = await makeTempConfig();
  const manager = new TestSwarmManager(config);
  const managerDescriptor = await bootWithDefaultManager(manager, config, { clearBootstrapSendCalls: false });
  const worker = await manager.spawnAgent(managerDescriptor.agentId, { agentId: "stall-worker" });

  const state = manager as any;
  const runtimeToken = state.runtimeTokensByAgentId.get(worker.agentId);
  await state.handleRuntimeStatus(runtimeToken, worker.agentId, "streaming", 0);

  const workerRuntime = manager.runtimeByAgentId.get(worker.agentId);
  const managerRuntime = manager.runtimeByAgentId.get(managerDescriptor.agentId);
  if (!workerRuntime || !managerRuntime) {
    throw new Error("Expected worker and manager runtimes");
  }

  managerRuntime.sendCalls = [];
  manager.publishedToUserCalls.length = 0;

  return {
    manager,
    managerDescriptor,
    worker,
    workerRuntime,
    managerRuntime,
    stallState: (state.workerStallState as Map<string, StallStateSnapshot>).get(worker.agentId)
  };
}

function readWorkerStallState(manager: TestSwarmManager, workerId: string): StallStateSnapshot | undefined {
  return (manager as any).workerStallState.get(workerId);
}

async function emitRuntimeEvent(manager: TestSwarmManager, workerId: string, event: RuntimeSessionEvent): Promise<void> {
  await (manager as any).handleRuntimeSessionEvent(workerId, event);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker stall detector", () => {
  it("sends a nudge when a worker has no meaningful activity for 5 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 5 * 60_000;
    stallState!.nudgeSent = false;
    stallState!.nudgeSentAt = null;

    await (manager as any).checkForStalledWorkers();

    const stallMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string")
      .filter((message) => message.includes("[WORKER STALL DETECTED]"));

    expect(stallMessages).toHaveLength(1);
    expect(stallMessages[0]).toContain(worker.agentId);
    expect(readWorkerStallState(manager, worker.agentId)?.nudgeSent).toBe(true);
    expect(manager.publishedToUserCalls.some((call) => call.source === "system" && call.text.includes("appears stalled"))).toBe(true);
  });

  it("sends a detailed stall report at 10 minutes with tool context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 10 * 60_000;
    stallState!.nudgeSent = true;
    stallState!.nudgeSentAt = Date.now() - 5 * 60_000;
    stallState!.lastToolName = "bash";
    stallState!.lastToolInput = `echo ${"a".repeat(240)}`;
    stallState!.lastToolOutput = `...${"z".repeat(240)}`;

    await (manager as any).checkForStalledWorkers();

    expect(workerRuntime.terminateCalls).toHaveLength(0);

    const reportMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string")
      .filter((message) => message.includes("[WORKER STALL REPORT]"));

    expect(reportMessages).toHaveLength(1);
    expect(reportMessages[0]).toContain("Tool: Bash");
    expect(reportMessages[0]).toContain("Input (truncated):");
    expect(reportMessages[0]).toContain("Last output (truncated):");
    expect(reportMessages[0]).toContain(`kill_agent(\"${worker.agentId}\")`);
    expect(readWorkerStallState(manager, worker.agentId)?.lastDetailedReportAt).toBe(Date.now());
    expect(
      manager.publishedToUserCalls.some(
        (call) => call.source === "system" && call.text.includes("still appears stalled")
      )
    ).toBe(true);
  });

  it("repeats detailed stall reports every 10 minutes while still stalled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 10 * 60_000;
    stallState!.nudgeSent = true;
    stallState!.nudgeSentAt = Date.now() - 5 * 60_000;
    stallState!.lastToolName = "read";
    stallState!.lastToolInput = "README.md";

    await (manager as any).checkForStalledWorkers();
    expect(workerRuntime.terminateCalls).toHaveLength(0);

    vi.advanceTimersByTime(9 * 60_000);
    await (manager as any).checkForStalledWorkers();

    vi.advanceTimersByTime(60_000);
    await (manager as any).checkForStalledWorkers();

    const reportMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string")
      .filter((message) => message.includes("[WORKER STALL REPORT]"));

    expect(reportMessages).toHaveLength(2);
    expect(workerRuntime.terminateCalls).toHaveLength(0);
  });

  it("auto-terminates a worker 25 minutes after a nudge if no progress occurs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 30 * 60_000;
    stallState!.nudgeSent = true;
    stallState!.nudgeSentAt = Date.now() - 25 * 60_000;

    await (manager as any).checkForStalledWorkers();

    expect(workerRuntime.terminateCalls).toHaveLength(1);
    expect(manager.getAgent(worker.agentId)?.status).toBe("terminated");

    const killMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string")
      .filter((message) => message.includes("[STALLED WORKER AUTO-TERMINATED]"));

    expect(killMessages).toHaveLength(1);
    expect(manager.publishedToUserCalls.some((call) => call.source === "system" && call.text.includes("auto-terminated"))).toBe(true);
  });

  it("tracks tool start/update details without resetting stall progress timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    const baseline = Date.now() - 120_000;
    stallState!.lastProgressAt = baseline;

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call-1",
      args: { command: "ls -la" }
    });

    const afterStart = readWorkerStallState(manager, worker.agentId);
    expect(afterStart?.lastProgressAt).toBe(baseline);
    expect(afterStart?.lastToolName).toBe("bash");
    expect(afterStart?.lastToolInput).toContain("ls -la");
    expect(afterStart?.lastToolOutput).toBeNull();

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "tool_execution_update",
      toolName: "bash",
      toolCallId: "call-1",
      partialResult: { line: "still running" }
    });

    const afterUpdate = readWorkerStallState(manager, worker.agentId);
    expect(afterUpdate?.lastProgressAt).toBe(baseline);
    expect(afterUpdate?.lastToolOutput).toContain("still running");
    expect((afterUpdate?.lastToolOutput ?? "").length).toBeLessThanOrEqual(500);
  });

  it("treats tool_execution_end as progress and resets nudge state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 120_000;
    stallState!.nudgeSent = true;
    stallState!.nudgeSentAt = Date.now() - 60_000;

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-2",
      result: { ok: true },
      isError: false
    });

    const updated = readWorkerStallState(manager, worker.agentId);
    expect(updated?.lastProgressAt).toBe(Date.now());
    expect(updated?.nudgeSent).toBe(false);
    expect(updated?.nudgeSentAt).toBeNull();
  });

  it("treats assistant message_update as progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 120_000;

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "thinking..." }]
      }
    });

    expect(readWorkerStallState(manager, worker.agentId)?.lastProgressAt).toBe(Date.now());
  });

  it("does not treat user-role message_update as progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    const baseline = Date.now() - 120_000;
    stallState!.lastProgressAt = baseline;

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "message_update",
      message: {
        role: "user",
        content: [{ type: "text", text: "queued steer" }]
      }
    });

    expect(readWorkerStallState(manager, worker.agentId)?.lastProgressAt).toBe(baseline);
  });

  it("does not treat user-role message_end as progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    const baseline = Date.now() - 120_000;
    stallState!.lastProgressAt = baseline;

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "queued steer" }]
      }
    });

    expect(readWorkerStallState(manager, worker.agentId)?.lastProgressAt).toBe(baseline);
  });

  it("skips stall checks while context recovery is in progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 10 * 60_000;
    workerRuntime.contextRecoveryInProgress = true;

    await (manager as any).checkForStalledWorkers();

    expect(managerRuntime.sendCalls).toHaveLength(0);
    expect(manager.publishedToUserCalls).toHaveLength(0);
    expect(readWorkerStallState(manager, worker.agentId)?.nudgeSent).toBe(false);
  });

  it("re-checks status before nudge/kill actions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime, managerRuntime } = await setupManagerWithStreamingWorker();
    const descriptors = (manager as any).descriptors as Map<string, AgentDescriptor>;
    const descriptor = descriptors.get(worker.agentId);
    expect(descriptor?.status).toBe("streaming");

    descriptor!.status = "idle";
    descriptor!.updatedAt = "2026-03-22T12:00:00.000Z";

    await (manager as any).handleStallNudge(worker.agentId, 5 * 60_000);
    await (manager as any).handleStallAutoKill(worker.agentId, 10 * 60_000);

    const stallManagerMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string")
      .filter(
        (message) =>
          message.includes("[WORKER STALL DETECTED]") ||
          message.includes("[STALLED WORKER AUTO-TERMINATED]")
      );

    expect(stallManagerMessages).toHaveLength(0);
    expect(
      manager.publishedToUserCalls.some(
        (call) => call.source === "system" && (call.text.includes("appears stalled") || call.text.includes("auto-terminated"))
      )
    ).toBe(false);
    expect(workerRuntime.terminateCalls).toHaveLength(0);
  });

  it("cleans stall state on stopWorker, terminateDescriptor, and stopAllAgents", async () => {
    vi.useFakeTimers();

    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    const managerDescriptor = await bootWithDefaultManager(manager, config, { clearBootstrapSendCalls: false });

    const workerForStop = await manager.spawnAgent(managerDescriptor.agentId, { agentId: "stop-worker" });
    const workerForTerminate = await manager.spawnAgent(managerDescriptor.agentId, { agentId: "terminate-worker" });
    const workerForStopAll = await manager.spawnAgent(managerDescriptor.agentId, { agentId: "stop-all-worker" });

    const state = manager as any;

    await state.handleRuntimeStatus(state.runtimeTokensByAgentId.get(workerForStop.agentId), workerForStop.agentId, "streaming", 0);
    await state.handleRuntimeStatus(state.runtimeTokensByAgentId.get(workerForTerminate.agentId), workerForTerminate.agentId, "streaming", 0);
    await state.handleRuntimeStatus(state.runtimeTokensByAgentId.get(workerForStopAll.agentId), workerForStopAll.agentId, "streaming", 0);

    expect(readWorkerStallState(manager, workerForStop.agentId)).toBeDefined();
    expect(readWorkerStallState(manager, workerForTerminate.agentId)).toBeDefined();
    expect(readWorkerStallState(manager, workerForStopAll.agentId)).toBeDefined();

    await manager.stopWorker(workerForStop.agentId);
    expect(readWorkerStallState(manager, workerForStop.agentId)).toBeUndefined();

    const terminateDescriptor = manager.getAgent(workerForTerminate.agentId);
    await state.terminateDescriptor(terminateDescriptor, { abort: true, emitStatus: false });
    expect(readWorkerStallState(manager, workerForTerminate.agentId)).toBeUndefined();

    await manager.stopAllAgents(managerDescriptor.agentId, managerDescriptor.agentId);
    expect(readWorkerStallState(manager, workerForStopAll.agentId)).toBeUndefined();
  });

  it("clears stall tracking and suppresses watchdog fallback when auto-report succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, managerRuntime } = await setupManagerWithStreamingWorker();
    const state = manager as any;
    const runtimeToken = state.runtimeTokensByAgentId.get(worker.agentId);

    await emitRuntimeEvent(manager, worker.agentId, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Finished cleanly." }]
      }
    });

    managerRuntime.sendCalls = [];

    await state.handleRuntimeStatus(runtimeToken, worker.agentId, "idle", 0);
    await state.handleRuntimeAgentEnd(runtimeToken, worker.agentId);
    await vi.advanceTimersByTimeAsync(3_800);

    const managerMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string");

    expect(managerMessages.some((message) => message.includes(`SYSTEM: Worker ${worker.agentId} completed its turn.`))).toBe(true);
    expect(managerMessages.some((message) => message.includes("[IDLE WORKER WATCHDOG"))).toBe(false);
    expect(managerMessages.some((message) => message.includes("[WORKER STALL DETECTED]"))).toBe(false);
    expect(readWorkerStallState(manager, worker.agentId)).toBeUndefined();
  });

  it("keeps stall detector and idle watchdog scoped to stuck versus completed-but-unreported turns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    const managerDescriptor = await bootWithDefaultManager(manager, config, { clearBootstrapSendCalls: false });
    const stalledWorker = await manager.spawnAgent(managerDescriptor.agentId, { agentId: "stalled-worker" });
    const silentWorker = await manager.spawnAgent(managerDescriptor.agentId, { agentId: "silent-worker" });
    const state = manager as any;

    const stalledRuntimeToken = state.runtimeTokensByAgentId.get(stalledWorker.agentId);
    const silentRuntimeToken = state.runtimeTokensByAgentId.get(silentWorker.agentId);
    await state.handleRuntimeStatus(stalledRuntimeToken, stalledWorker.agentId, "streaming", 0);
    await state.handleRuntimeStatus(silentRuntimeToken, silentWorker.agentId, "streaming", 0);

    const stalledState = readWorkerStallState(manager, stalledWorker.agentId);
    expect(stalledState).toBeDefined();
    stalledState!.lastProgressAt = Date.now() - 5 * 60_000;

    const managerRuntime = manager.runtimeByAgentId.get(managerDescriptor.agentId);
    expect(managerRuntime).toBeDefined();
    if (!managerRuntime) {
      throw new Error("Expected manager runtime");
    }

    const originalSendMessage = managerRuntime.sendMessage.bind(managerRuntime);
    managerRuntime.sendMessage = async (message, delivery = "auto") => {
      if (
        typeof message === "string" &&
        message.startsWith(`SYSTEM: Worker ${silentWorker.agentId} completed its turn.`) &&
        !message.includes("[IDLE WORKER WATCHDOG — BATCHED]")
      ) {
        throw new Error("synthetic auto-report failure");
      }

      return originalSendMessage(message, delivery);
    };
    managerRuntime.sendCalls = [];

    await state.handleRuntimeStatus(silentRuntimeToken, silentWorker.agentId, "idle", 0);
    await state.handleRuntimeAgentEnd(silentRuntimeToken, silentWorker.agentId);

    expect(readWorkerStallState(manager, silentWorker.agentId)).toBeUndefined();
    expect(readWorkerStallState(manager, stalledWorker.agentId)).toBeDefined();

    await (manager as any).checkForStalledWorkers();
    await vi.advanceTimersByTimeAsync(3_800);

    const managerMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string");
    const stallMessages = managerMessages.filter((message) => message.includes("[WORKER STALL DETECTED]"));
    const watchdogMessages = managerMessages.filter((message) => message.includes("[IDLE WORKER WATCHDOG — BATCHED]"));

    expect(stallMessages).toHaveLength(1);
    expect(stallMessages[0]).toContain(stalledWorker.agentId);
    expect(stallMessages[0]).not.toContain(silentWorker.agentId);

    expect(watchdogMessages).toHaveLength(1);
    expect(watchdogMessages[0]).toContain(`\`${silentWorker.agentId}\``);
    expect(watchdogMessages[0]).not.toContain(`\`${stalledWorker.agentId}\``);
  });

  it("does not mark nudge as sent when sendMessage fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 5 * 60_000;

    const sendSpy = vi.spyOn(manager, "sendMessage").mockRejectedValue(new Error("synthetic nudge failure"));

    await (manager as any).checkForStalledWorkers();

    expect(sendSpy).toHaveBeenCalled();
    expect(readWorkerStallState(manager, worker.agentId)?.nudgeSent).toBe(false);
    expect(manager.publishedToUserCalls.some((call) => call.source === "system" && call.text.includes("appears stalled"))).toBe(true);
  });

  it("does not send duplicate nudges when stall checks overlap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 5 * 60_000;

    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = () => resolve();
    });
    const originalSendMessage = manager.sendMessage.bind(manager);

    const sendSpy = vi.spyOn(manager, "sendMessage").mockImplementation(async (...args) => {
      const message = args[2];
      if (typeof message === "string" && message.includes("[WORKER STALL DETECTED]")) {
        await sendGate;
      }
      return originalSendMessage(...args);
    });

    const firstCheck = (manager as any).checkForStalledWorkers();
    await Promise.resolve();
    const secondCheck = (manager as any).checkForStalledWorkers();

    releaseSend();
    await Promise.all([firstCheck, secondCheck]);

    const stallMessages = managerRuntime.sendCalls
      .map((call) => call.message)
      .filter((message): message is string => typeof message === "string")
      .filter((message) => message.includes("[WORKER STALL DETECTED]"));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(stallMessages).toHaveLength(1);
    expect(manager.publishedToUserCalls.filter((call) => call.source === "system" && call.text.includes("appears stalled"))).toHaveLength(1);
  });

  it("resets nudge state on context recovery events to prevent false auto-kill after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime, managerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    // Simulate: nudge was sent 26 minutes ago (past kill threshold)
    stallState!.lastProgressAt = Date.now() - 27 * 60_000;
    stallState!.nudgeSent = true;
    stallState!.nudgeSentAt = Date.now() - 26 * 60_000;

    // Worker enters context recovery — this should reset nudge state
    await emitRuntimeEvent(manager, worker.agentId, {
      type: "auto_compaction_start",
      reason: "threshold"
    });

    const afterCompactionStart = readWorkerStallState(manager, worker.agentId);
    expect(afterCompactionStart?.nudgeSent).toBe(false);
    expect(afterCompactionStart?.nudgeSentAt).toBeNull();
    expect(afterCompactionStart?.lastProgressAt).toBe(Date.now());

    // Even if the check runs now (after recovery completes), it should NOT auto-kill
    // because nudge state was reset
    await emitRuntimeEvent(manager, worker.agentId, {
      type: "auto_compaction_end",
      result: { status: "ok" },
      aborted: false,
      willRetry: false
    });

    await (manager as any).checkForStalledWorkers();

    expect(workerRuntime.terminateCalls).toHaveLength(0);
    expect(managerRuntime.sendCalls).toHaveLength(0);
  });

  it("notifies user when auto-kill terminateDescriptor fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));

    const { manager, worker, workerRuntime } = await setupManagerWithStreamingWorker();
    const stallState = readWorkerStallState(manager, worker.agentId);
    expect(stallState).toBeDefined();

    stallState!.lastProgressAt = Date.now() - 30 * 60_000;
    stallState!.nudgeSent = true;
    stallState!.nudgeSentAt = Date.now() - 25 * 60_000;

    // Make terminate fail
    workerRuntime.terminate = async () => {
      throw new Error("synthetic terminate failure");
    };

    manager.publishedToUserCalls.length = 0;
    await (manager as any).checkForStalledWorkers();

    // Worker should NOT be terminated (terminate threw)
    expect(manager.getAgent(worker.agentId)?.status).toBe("streaming");

    // User should be notified about the failure
    expect(
      manager.publishedToUserCalls.some(
        (call) => call.source === "system" && call.text.includes("Failed to auto-terminate")
      )
    ).toBe(true);
  });
});
