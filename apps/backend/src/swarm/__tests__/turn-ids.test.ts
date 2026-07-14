import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolCallEvent, ConversationMessageEvent } from "../types.js";
import type { AssistantOutputTarget } from "../runtime/manager-assistant-output-tracker.js";
import { createTempConfig, type TempConfigHandle, TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";

const tempHandles: TempConfigHandle[] = [];

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
});

async function makeConfig() {
  const handle = await createTempConfig({
    prefix: "turn-ids-",
    port: 0,
  });
  tempHandles.push(handle);
  return handle.config;
}

function collectEvents<T>(manager: TestSwarmManager, eventName: "conversation_message" | "agent_tool_call"): T[] {
  const events: T[] = [];
  manager.on(eventName, (event) => events.push(event as T));
  return events;
}

function activeAssistantOutputTarget(manager: TestSwarmManager, agentId: string): AssistantOutputTarget | undefined {
  return (manager as any).assistantOutputRouter.getActiveTarget(agentId);
}

function oldAgentMessageContextActivationEligible(input: {
  targetRole: "manager" | "worker";
  hasObservabilityInput: boolean;
  assistantOutputTarget: AssistantOutputTarget;
  assistantOutputProjectionTarget: AssistantOutputTarget;
  isAssistantOutputEligibleWorkerReport: boolean;
}): boolean {
  return (
    input.targetRole === "manager" &&
    (input.hasObservabilityInput ||
      input.assistantOutputProjectionTarget.kind !== "internal_only" ||
      input.assistantOutputTarget.kind !== "internal_only" ||
      input.isAssistantOutputEligibleWorkerReport)
  );
}

async function createWorkerHarness(agentId: string, runtimeToken: number): Promise<{
  manager: TestSwarmManager;
  sessionId: string;
  workerId: string;
  runtimeToken: number;
}> {
  const config = await makeConfig();
  const manager = new TestSwarmManager(config);
  const session = await bootWithDefaultManager(manager, config);
  const worker = await manager.spawnAgent(session.agentId, { agentId });
  manager.runtimeTokensByAgentId.set(worker.agentId, runtimeToken);
  return {
    manager,
    sessionId: session.agentId,
    workerId: worker.agentId,
    runtimeToken,
  };
}

describe("server-owned turn ids", () => {
  it("refuses user-visible actions from a turn with newer queued user input", async () => {
    const config = await makeConfig();
    const manager = new TestSwarmManager(config);
    const session = await bootWithDefaultManager(manager, config);
    const messages = collectEvents<ConversationMessageEvent>(manager, "conversation_message");
    const target: AssistantOutputTarget = {
      kind: "session_transcript",
      channel: "web",
      sourceContext: { channel: "web" },
    };

    await manager.enqueueInboundTurnContextForTest(session.agentId, {
      source: "user_input",
      runtimeMessageText: "first request",
      assistantOutputTarget: target,
      routeOrigin: "user",
    });
    manager.beforeRuntimeEventProjection(session.agentId, undefined, {
      type: "message_start",
      message: { role: "user", content: "first request" },
    });
    const firstTurnId = manager.getActiveTurnId(session.agentId);

    await manager.enqueueInboundTurnContextForTest(session.agentId, {
      source: "user_input",
      runtimeMessageText: "newer request",
      assistantOutputTarget: target,
      routeOrigin: "user",
    });

    const result = await manager.publishToUser(session.agentId, "Stale response", "speak_to_user");

    expect(firstTurnId).toBeDefined();
    expect(result).toMatchObject({ published: false, reason: "superseded_by_user_input" });
    expect(messages).not.toContainEqual(expect.objectContaining({ text: "Stale response" }));
    await expect(manager.requestUserChoice(session.agentId, [{ id: "q1", question: "Stale choice?" }]))
      .rejects.toThrow(/newer user message superseded/i);
  });

  it("preserves pre-turn-id assistant-output activation semantics for guarded agent_message flows", async () => {
    const sessionTranscriptTarget: AssistantOutputTarget = {
      kind: "session_transcript",
      channel: "web",
      sourceContext: { channel: "web" },
    };
    const internalOnlyTarget: AssistantOutputTarget = { kind: "internal_only", reason: "matrix" };
    const cases: Array<{
      name: string;
      targetRole: "manager" | "worker";
      hasObservabilityInput: boolean;
      assistantOutputTarget: AssistantOutputTarget;
      assistantOutputProjectionTarget: AssistantOutputTarget;
      isAssistantOutputEligibleWorkerReport: boolean;
      expectedActiveTarget?: AssistantOutputTarget;
    }> = [
      {
        name: "non-manager target",
        targetRole: "worker",
        hasObservabilityInput: false,
        assistantOutputTarget: sessionTranscriptTarget,
        assistantOutputProjectionTarget: sessionTranscriptTarget,
        isAssistantOutputEligibleWorkerReport: false,
      },
      {
        name: "manager internal_only without observability",
        targetRole: "manager",
        hasObservabilityInput: false,
        assistantOutputTarget: internalOnlyTarget,
        assistantOutputProjectionTarget: internalOnlyTarget,
        isAssistantOutputEligibleWorkerReport: false,
      },
      {
        name: "manager with observabilityInput",
        targetRole: "manager",
        hasObservabilityInput: true,
        assistantOutputTarget: internalOnlyTarget,
        assistantOutputProjectionTarget: internalOnlyTarget,
        isAssistantOutputEligibleWorkerReport: false,
        expectedActiveTarget: internalOnlyTarget,
      },
      {
        name: "eligible worker report",
        targetRole: "manager",
        hasObservabilityInput: false,
        assistantOutputTarget: sessionTranscriptTarget,
        assistantOutputProjectionTarget: sessionTranscriptTarget,
        isAssistantOutputEligibleWorkerReport: true,
        expectedActiveTarget: sessionTranscriptTarget,
      },
    ];

    for (const matrixCase of cases) {
      const config = await makeConfig();
      const manager = new TestSwarmManager(config);
      const session = await bootWithDefaultManager(manager, config);
      const worker = await manager.spawnAgent(session.agentId, { agentId: `worker-${matrixCase.name}` });
      const targetAgentId = matrixCase.targetRole === "manager" ? session.agentId : worker.agentId;
      const activationEligible = oldAgentMessageContextActivationEligible(matrixCase);

      const queuedTurn = await (manager as any).turnContextCoordinator.enqueue(targetAgentId, {
        source: "agent_message",
        runtimeMessageText: `runtime input for ${matrixCase.name}`,
        rootTurnId: matrixCase.hasObservabilityInput ? `root-${matrixCase.name}` : undefined,
        assistantOutputTarget: matrixCase.assistantOutputTarget,
        assistantOutputProjectionTarget: matrixCase.assistantOutputProjectionTarget,
        activationEligible,
      });
      const turnId = queuedTurn.turnId;

      manager.beforeRuntimeEventProjection(targetAgentId, undefined, { type: "turn_start" });
      expect(activeAssistantOutputTarget(manager, targetAgentId), `${matrixCase.name}: turn_start`).toBeUndefined();

      manager.beforeRuntimeEventProjection(targetAgentId, undefined, {
        type: "message_start",
        message: { role: "user", content: `runtime input for ${matrixCase.name}` },
      });

      expect(activeAssistantOutputTarget(manager, targetAgentId), matrixCase.name).toEqual(matrixCase.expectedActiveTarget);
      expect(manager.getActiveTurnId(targetAgentId), matrixCase.name).toBe(turnId);
    }
  });

  it("associates projected Pi runtime events with the minted worker turn id through turn end", async () => {
    const { manager, sessionId, workerId, runtimeToken } = await createWorkerHarness("worker-turn-id", 101);
    const messages = collectEvents<ConversationMessageEvent>(manager, "conversation_message");
    const toolCalls = collectEvents<AgentToolCallEvent>(manager, "agent_tool_call");

    await manager.sendMessage(sessionId, workerId, "inspect this", "auto");
    const turnId = manager.getActiveTurnId(workerId);
    expect(turnId).toBeDefined();

    const replacementRuntimeToken = runtimeToken + 1;
    manager.runtimeTokensByAgentId.set(workerId, replacementRuntimeToken);
    await manager.handleRuntimeSessionEvent(replacementRuntimeToken, workerId, { type: "tool_execution_start", toolName: "read_file", toolCallId: "tool-after-swap", args: { path: "src/index.ts" } });
    expect(toolCalls[0]?.turnId).toBeUndefined();
    manager.runtimeTokensByAgentId.set(workerId, runtimeToken);

    await manager.handleRuntimeSessionEvent(runtimeToken, workerId, { type: "message_start", message: { role: "user", content: "SYSTEM: inspect this" } });
    await manager.handleRuntimeSessionEvent(runtimeToken, workerId, { type: "tool_execution_start", toolName: "read_file", toolCallId: "tool-1", args: { path: "src/index.ts" } });
    await manager.handleRuntimeSessionEvent(runtimeToken, workerId, { type: "tool_execution_end", toolName: "read_file", toolCallId: "tool-1", result: { ok: true }, isError: false });
    await manager.handleRuntimeSessionEvent(runtimeToken, workerId, { type: "message_end", message: { role: "assistant", content: "done", stopReason: "stop" } });
    await manager.handleRuntimeSessionEvent(runtimeToken, workerId, { type: "turn_end", toolResults: [] });

    expect(toolCalls).toHaveLength(3);
    expect(toolCalls.filter((event) => event.toolCallId === "tool-1").every((event) => event.turnId === turnId)).toBe(true);
    const workerMessage = messages.find((event) => event.agentId === workerId && event.text === "done");
    expect(workerMessage?.turnId).toBe(turnId);
    expect(manager.getActiveTurnId(workerId)).toBeUndefined();
  });
});
