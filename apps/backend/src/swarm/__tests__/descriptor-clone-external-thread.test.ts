import { describe, expect, it } from "vitest";

import {
  cloneDescriptorForPersistence,
  cloneDescriptorForPublic,
  cloneExternalThread,
} from "../agents/descriptor-store/descriptor-clone.js";
import type { AgentDescriptor } from "../types.js";

function codexWorkerDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "mgr-1--codex",
    managerId: "mgr-1",
    displayName: "Codex",
    role: "worker",
    status: "idle",
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    cwd: "/tmp",
    model: {
      provider: "codex-app-server",
      modelId: "app-server",
      thinkingLevel: "none",
    },
    sessionFile: "/tmp/workers/mgr-1--codex.jsonl",
    externalThread: {
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
      threadId: "thread-1",
      lastTurnId: "turn-1",
    },
    ...overrides,
  };
}

describe("descriptor clone externalThread", () => {
  it("cloneExternalThread does not alias nested fields", () => {
    const source = {
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
      threadId: "thread-1",
    } as const;

    const cloned = cloneExternalThread(source);
    expect(cloned).not.toBe(source);
    expect(cloned).toEqual(source);

    (cloned as { threadId: string }).threadId = "mutated";
    expect(source.threadId).toBe("thread-1");
  });

  it("cloneDescriptorForPersistence deep-clones externalThread", () => {
    const source = codexWorkerDescriptor();
    const cloned = cloneDescriptorForPersistence(source);

    expect(cloned.externalThread).not.toBe(source.externalThread);
    expect(cloned.externalThread).toEqual(source.externalThread);

    cloned.externalThread!.threadId = "mutated";
    expect(source.externalThread?.threadId).toBe("thread-1");
  });

  it("cloneDescriptorForPublic deep-clones externalThread", () => {
    const source = codexWorkerDescriptor();
    const cloned = cloneDescriptorForPublic(source);

    expect(cloned.externalThread).not.toBe(source.externalThread);
    expect(cloned.externalThread).toEqual(source.externalThread);

    cloned.externalThread!.lastTurnId = "mutated";
    expect(source.externalThread?.lastTurnId).toBe("turn-1");
  });
});
