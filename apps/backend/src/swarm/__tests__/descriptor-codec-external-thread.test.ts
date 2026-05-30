import { describe, expect, it, vi } from "vitest";

import { decodeAgentsStoreFile } from "../agents/descriptor-store/descriptor-codec.js";

const storeOptions = {
  dataDir: "/tmp/forge-data",
  storeFilePath: "/tmp/forge-data/swarm/agents.json",
  logDebug: vi.fn(),
  warn: vi.fn(),
};

function baseAgent(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe("decodeAgentsStoreFile externalThread validation", () => {
  it("keeps valid Codex external-thread descriptors and skips malformed ones", () => {
    const decoded = decodeAgentsStoreFile(
      JSON.stringify({
        agents: [
          baseAgent({
            externalThread: {
              type: "codex_app_server",
              persisted: true,
              createdByMention: true,
              threadId: "thread-1",
            },
          }),
          baseAgent({
            agentId: "mgr-1--codex-bad",
            externalThread: {
              type: "codex_app_server",
              persisted: false,
              createdByMention: true,
            },
          }),
        ],
      }),
      storeOptions,
    );

    expect(decoded.skippedDescriptorCount).toBe(1);
    expect(decoded.store.agents).toHaveLength(1);
    expect(decoded.store.agents[0]?.externalThread).toEqual({
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
      threadId: "thread-1",
    });
    expect(storeOptions.warn).toHaveBeenCalled();
  });
});
