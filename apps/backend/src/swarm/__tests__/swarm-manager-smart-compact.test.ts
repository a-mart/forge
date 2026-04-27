import { afterEach, describe, expect, it } from "vitest";
import {
  bootWithDefaultManager,
  createTempConfig,
  TestSwarmManager,
  type TempConfigHandle
} from "../../test-support/index.js";

describe("SwarmManager smart compact", () => {
  const tempHandles: TempConfigHandle[] = [];

  afterEach(async () => {
    await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()));
  });

  it("marks manual smart compaction as skip-resume-if-idle for idle managers", async () => {
    const handle = await createTempConfig({ prefix: "smart-compact-idle-" });
    tempHandles.push(handle);

    const manager = new TestSwarmManager(handle.config);
    const session = await bootWithDefaultManager(manager, handle.config);
    const runtime = manager.runtimeByAgentId.get(session.agentId);
    expect(runtime).toBeDefined();

    const messages: string[] = [];
    manager.on("conversation_message", (event) => {
      if (event.type === "conversation_message") {
        messages.push(event.text);
      }
    });

    await manager.smartCompactAgentContext(session.agentId);

    expect(runtime?.smartCompactCalls).toEqual([
      {
        customInstructions: undefined,
        options: { skipResumeIfIdle: true }
      }
    ]);
    expect(messages[0]).toBe("Running smart compaction…");
    expect(messages.at(-1)).toBe("Smart compaction complete.");
  });

  it("uses generic failure copy when smart compaction does not reduce context", async () => {
    const handle = await createTempConfig({ prefix: "smart-compact-failure-" });
    tempHandles.push(handle);

    const manager = new TestSwarmManager(handle.config);
    const session = await bootWithDefaultManager(manager, handle.config);
    const runtime = manager.runtimeByAgentId.get(session.agentId);
    expect(runtime).toBeDefined();

    if (!runtime) {
      throw new Error("Expected manager runtime");
    }

    runtime.smartCompactResult = {
      compacted: false,
      reason: "runtime_aborted"
    };

    const messages: string[] = [];
    manager.on("conversation_message", (event) => {
      if (event.type === "conversation_message") {
        messages.push(event.text);
      }
    });

    await manager.smartCompactAgentContext(session.agentId);

    expect(messages.at(-1)).toBe("Smart compaction finished but context was not reduced (runtime_aborted).");
  });

  it("passes the same runtime-level idle check option even when manager status is already streaming", async () => {
    const handle = await createTempConfig({ prefix: "smart-compact-active-" });
    tempHandles.push(handle);

    const manager = new TestSwarmManager(handle.config);
    const session = await bootWithDefaultManager(manager, handle.config);
    const runtime = manager.runtimeByAgentId.get(session.agentId);
    const descriptor = manager.getAgent(session.agentId);
    expect(runtime).toBeDefined();
    expect(descriptor).toBeDefined();

    if (!runtime || !descriptor) {
      throw new Error("Expected manager runtime and descriptor");
    }

    runtime.descriptor.status = "streaming";
    descriptor.status = "streaming";

    const messages: string[] = [];
    manager.on("conversation_message", (event) => {
      if (event.type === "conversation_message") {
        messages.push(event.text);
      }
    });

    await manager.smartCompactAgentContext(session.agentId);

    expect(runtime.smartCompactCalls).toEqual([
      {
        customInstructions: undefined,
        options: { skipResumeIfIdle: true }
      }
    ]);
    expect(messages[0]).toBe("Running smart compaction…");
    expect(messages.at(-1)).toBe("Smart compaction complete.");
  });
});
