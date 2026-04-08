import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendModelChangeContinuityApplied,
  appendModelChangeContinuityRequest,
  createModelChangeContinuityApplied,
  createModelChangeContinuityRequest,
  findLatestPendingModelChangeContinuityRequest,
  inferModelChangeContinuityRuntimeKind,
  loadModelChangeContinuityState
} from "../runtime/model-change-continuity.js";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

describe("model-change-continuity", () => {
  it("infers runtime kind from provider", () => {
    expect(inferModelChangeContinuityRuntimeKind({ provider: "claude-sdk" })).toBe("claude");
    expect(inferModelChangeContinuityRuntimeKind({ provider: "openai-codex-app-server" })).toBe("codex");
    expect(inferModelChangeContinuityRuntimeKind({ provider: "openai-codex" })).toBe("pi");
  });

  it("persists and reloads request/applied continuity metadata", async () => {
    const root = await createTempDir("model-change-continuity-");
    const sessionFile = join(root, "session.jsonl");

    const request = createModelChangeContinuityRequest({
      requestId: "req-1",
      createdAt: "2026-01-02T00:00:00.000Z",
      sessionAgentId: "manager-1",
      sourceModel: {
        provider: "claude-sdk",
        modelId: "sonnet-4-5",
        thinkingLevel: "high"
      },
      targetModel: {
        provider: "openai-codex",
        modelId: "gpt-5.4",
        thinkingLevel: "x-high"
      }
    });
    const applied = createModelChangeContinuityApplied({
      requestId: request.requestId,
      appliedAt: "2026-01-02T00:00:05.000Z",
      sessionAgentId: "manager-1",
      attachedRuntime: {
        provider: "openai-codex",
        modelId: "gpt-5.4"
      }
    });

    await appendModelChangeContinuityRequest({
      sessionFile,
      cwd: root,
      request,
      now: () => "2026-01-02T00:00:00.000Z"
    });
    await appendModelChangeContinuityApplied({
      sessionFile,
      cwd: root,
      applied,
      now: () => "2026-01-02T00:00:05.000Z"
    });

    const state = await loadModelChangeContinuityState(sessionFile);
    expect(state.requests).toEqual([
      {
        ...request,
        targetModel: {
          ...request.targetModel,
          thinkingLevel: "xhigh"
        }
      }
    ]);
    expect(state.applied).toEqual([applied]);

    const persisted = readFileSync(sessionFile, "utf8");
    expect(persisted).toContain("swarm_model_change_continuity_request");
    expect(persisted).toContain("swarm_model_change_continuity_applied");
  });

  it("finds the newest matching request that has not been applied", () => {
    const stale = createModelChangeContinuityRequest({
      requestId: "req-stale",
      createdAt: "2026-01-02T00:00:00.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "claude-sdk", modelId: "sonnet-4-5", thinkingLevel: "high" },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" }
    });
    const matching = createModelChangeContinuityRequest({
      requestId: "req-match",
      createdAt: "2026-01-02T00:00:10.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "claude-sdk", modelId: "sonnet-4-5", thinkingLevel: "high" },
      targetModel: { provider: "anthropic", modelId: "claude-opus-4-1", thinkingLevel: "high" }
    });
    const superseded = createModelChangeContinuityRequest({
      requestId: "req-applied",
      createdAt: "2026-01-02T00:00:20.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "claude-sdk", modelId: "sonnet-4-5", thinkingLevel: "high" },
      targetModel: { provider: "anthropic", modelId: "claude-opus-4-1", thinkingLevel: "high" }
    });
    const applied = createModelChangeContinuityApplied({
      requestId: "req-applied",
      appliedAt: "2026-01-02T00:00:30.000Z",
      sessionAgentId: "manager-1",
      attachedRuntime: { provider: "anthropic", modelId: "claude-opus-4-1" }
    });

    const pending = findLatestPendingModelChangeContinuityRequest({
      sessionAgentId: "manager-1",
      requests: [stale, matching, superseded],
      applied: [applied],
      targetModel: { provider: "anthropic", modelId: "claude-opus-4-1", thinkingLevel: "high" }
    });

    expect(pending?.requestId).toBe("req-match");
  });

  it("does not rematch stale same-model reasoning changes after a newer deferred request was applied", () => {
    const firstDeferred = createModelChangeContinuityRequest({
      requestId: "req-high",
      createdAt: "2026-01-02T00:00:00.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" }
    });
    const latestApplied = createModelChangeContinuityRequest({
      requestId: "req-low",
      createdAt: "2026-01-02T00:00:10.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "low" }
    });
    const applied = createModelChangeContinuityApplied({
      requestId: latestApplied.requestId,
      appliedAt: "2026-01-02T00:00:20.000Z",
      sessionAgentId: "manager-1",
      attachedRuntime: { provider: "openai-codex", modelId: "gpt-5.4" }
    });

    const pending = findLatestPendingModelChangeContinuityRequest({
      sessionAgentId: "manager-1",
      requests: [firstDeferred, latestApplied],
      applied: [applied],
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "low" }
    });

    expect(pending).toBeUndefined();
  });

  it("treats partially written requests as inert when the current descriptor target no longer matches", () => {
    const request = createModelChangeContinuityRequest({
      requestId: "req-1",
      createdAt: "2026-01-02T00:00:00.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "claude-sdk", modelId: "sonnet-4-5", thinkingLevel: "high" },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" }
    });

    const pending = findLatestPendingModelChangeContinuityRequest({
      sessionAgentId: "manager-1",
      requests: [request],
      applied: [],
      targetModel: { provider: "anthropic", modelId: "claude-opus-4-1" }
    });

    expect(pending).toBeUndefined();
  });

  it("ignores fork-copied parent request/applied entries when resolving a child session", () => {
    const parentRequest = createModelChangeContinuityRequest({
      requestId: "req-parent",
      createdAt: "2026-01-02T00:00:00.000Z",
      sessionAgentId: "manager-parent",
      sourceModel: { provider: "claude-sdk", modelId: "sonnet-4-5", thinkingLevel: "high" },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" }
    });
    const parentApplied = createModelChangeContinuityApplied({
      requestId: "req-parent",
      appliedAt: "2026-01-02T00:00:05.000Z",
      sessionAgentId: "manager-parent",
      attachedRuntime: { provider: "openai-codex", modelId: "gpt-5.4" }
    });

    const pending = findLatestPendingModelChangeContinuityRequest({
      sessionAgentId: "manager-child",
      requests: [parentRequest],
      applied: [parentApplied],
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" }
    });

    expect(pending).toBeUndefined();
  });
});
