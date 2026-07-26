import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import {
  createModelChangeContinuityRequest,
  type ModelChangeContinuityRequest
} from "../runtime/model-change-continuity.js";
import {
  ModelChangeStartupRecoveryCoordinator,
  type ModelChangeStartupRecoveryManagerDescriptor
} from "../runtime/model-change-startup-recovery-coordinator.js";
import type { AgentDescriptor } from "../types.js";

const createdDirs: string[] = [];
const NOW = "2026-04-08T00:00:09.000Z";

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

function sessionHeader(cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-08T00:00:00.000Z",
    cwd
  });
}

function customLine(customType: string, data: unknown, id: string): string {
  return JSON.stringify({
    type: "custom",
    customType,
    data,
    id,
    timestamp: "2026-04-08T00:00:00.000Z"
  });
}

function createDescriptor(options: {
  root: string;
  sessionFile: string;
  provider?: string;
  modelId?: string;
  reasoningLevel?: string;
}): ModelChangeStartupRecoveryManagerDescriptor {
  return {
    agentId: "manager-1",
    role: "manager",
    profileId: "profile-1",
    cwd: options.root,
    sessionFile: options.sessionFile,
    model: {
      provider: options.provider ?? "openai-codex",
      modelId: options.modelId ?? "gpt-5.4",
      thinkingLevel: options.reasoningLevel ?? "xhigh"
    }
  } as unknown as ModelChangeStartupRecoveryManagerDescriptor;
}

function createCoordinator(overrides?: {
  getEffectiveContextWindow?: (modelId: string, provider?: string) => number | undefined;
  hasPinnedContent?: (agentId: string) => boolean;
  logDebug?: (message: string, details?: Record<string, unknown>) => void;
}): {
  coordinator: ModelChangeStartupRecoveryCoordinator;
  logDebug: ReturnType<typeof vi.fn>;
  getEffectiveContextWindow: ReturnType<typeof vi.fn>;
  hasPinnedContent: ReturnType<typeof vi.fn>;
} {
  const logDebug = vi.fn(overrides?.logDebug);
  const getEffectiveContextWindow = vi.fn(overrides?.getEffectiveContextWindow ?? (() => 200_000));
  const hasPinnedContent = vi.fn(overrides?.hasPinnedContent ?? (() => false));

  return {
    coordinator: new ModelChangeStartupRecoveryCoordinator({
      now: () => NOW,
      logDebug,
      getEffectiveContextWindow,
      hasPinnedContent
    }),
    logDebug,
    getEffectiveContextWindow,
    hasPinnedContent
  };
}

function createRequest(options?: {
  requestId?: string;
  sourceProvider?: string;
  sourceModelId?: string;
  targetProvider?: string;
  targetModelId?: string;
}): ModelChangeContinuityRequest {
  return createModelChangeContinuityRequest({
    requestId: options?.requestId ?? "req-1",
    createdAt: "2026-04-08T00:00:01.000Z",
    sessionAgentId: "manager-1",
    sourceModel: {
      provider: options?.sourceProvider ?? "cursor-sdk",
      modelId: options?.sourceModelId ?? "cursor-agent",
      thinkingLevel: "high"
    },
    targetModel: {
      provider: options?.targetProvider ?? "openai-codex",
      modelId: options?.targetModelId ?? "gpt-5.4",
      thinkingLevel: "xhigh"
    }
  });
}

async function writeSession(sessionFile: string, root: string, lines: string[]): Promise<void> {
  await writeFile(sessionFile, [sessionHeader(root), ...lines].join("\n") + "\n", "utf8");
}

describe("ModelChangeStartupRecoveryCoordinator", () => {
  it("returns an empty prepare result and does not log recovery detail when no pending request exists", async () => {
    const root = await createTempDir("model-change-startup-coordinator-");
    const sessionFile = join(root, "session.jsonl");
    await writeSession(sessionFile, root, []);
    const descriptor = createDescriptor({ root, sessionFile });
    const { coordinator, logDebug } = createCoordinator();

    await expect(coordinator.prepareManagerRuntimeCreation(descriptor, "Base prompt")).resolves.toEqual({});
    expect(logDebug).not.toHaveBeenCalled();
  });

  it("returns a continuity request and startup recovery context for cross-runtime pending requests", async () => {
    const root = await createTempDir("model-change-startup-coordinator-");
    const sessionFile = join(root, "session.jsonl");
    const request = createRequest();
    await writeSession(sessionFile, root, [
      customLine("swarm_model_change_continuity_request", request, "r1"),
      customLine(
        "swarm_conversation_entry",
        {
          type: "conversation_message",
          agentId: "manager-1",
          role: "user",
          text: "Keep durable context.",
          timestamp: "2026-04-08T00:00:04.000Z",
          source: "user_input"
        },
        "e1"
      )
    ]);
    const descriptor = createDescriptor({ root, sessionFile });
    const { coordinator, logDebug, getEffectiveContextWindow, hasPinnedContent } = createCoordinator({
      getEffectiveContextWindow: () => 150_000,
      hasPinnedContent: () => true
    });

    const result = await coordinator.prepareManagerRuntimeCreation(descriptor, "Base prompt");

    expect(result.continuityRequest?.requestId).toBe("req-1");
    expect(result.runtimeCreationOptions?.startupRecoveryContext?.reason).toBe("model_change");
    expect(result.runtimeCreationOptions?.startupRecoveryContext?.blockText).toContain(
      "# Recovered Forge Conversation Context"
    );
    expect(result.runtimeCreationOptions?.startupRecoveryContext?.blockText).toContain("User: Keep durable context.");
    expect(getEffectiveContextWindow).toHaveBeenCalledWith("gpt-5.4", "openai-codex");
    expect(hasPinnedContent).toHaveBeenCalledWith("manager-1");
    expect(logDebug).toHaveBeenCalledWith(
      "manager:model_change_continuity:prepare",
      expect.objectContaining({
        agentId: "manager-1",
        requestId: "req-1",
        policy: "recovered",
        eligibleEntryCount: 1,
        includedEntryCount: 1
      })
    );
  });

  it("returns the continuity request without runtime creation options for pi-to-pi pending requests", async () => {
    const root = await createTempDir("model-change-startup-coordinator-");
    const sessionFile = join(root, "session.jsonl");
    const request = createRequest({ sourceProvider: "openai-codex", targetProvider: "anthropic", targetModelId: "claude-opus-4-6" });
    request.sourceModel.runtimeKind = "pi";
    request.targetModel.runtimeKind = "pi";
    await writeSession(sessionFile, root, [customLine("swarm_model_change_continuity_request", request, "r1")]);
    const descriptor = createDescriptor({ root, sessionFile, provider: "anthropic", modelId: "claude-opus-4-6" });
    const { coordinator, logDebug } = createCoordinator();

    const result = await coordinator.prepareManagerRuntimeCreation(descriptor, "Base prompt");

    expect(result.continuityRequest?.requestId).toBe("req-1");
    expect(result.runtimeCreationOptions).toBeUndefined();
    expect(logDebug).toHaveBeenCalledWith(
      "manager:model_change_continuity:prepare",
      expect.objectContaining({ policy: "skip_pi_to_pi" })
    );
  });

  it("appends an applied marker with descriptor paths, request id, session agent id, now, and attached runtime model", async () => {
    const root = await createTempDir("model-change-startup-coordinator-");
    const sessionFile = join(root, "session.jsonl");
    const request = createRequest();
    await writeSession(sessionFile, root, [customLine("swarm_model_change_continuity_request", request, "r1")]);
    const descriptor = createDescriptor({ root, sessionFile });
    const runtime = {
      descriptor: {
        model: {
          provider: "openai-codex",
          modelId: "gpt-5.4"
        }
      } as AgentDescriptor
    } as SwarmAgentRuntime;
    const { coordinator } = createCoordinator();

    await coordinator.appendAppliedModelChangeContinuity(descriptor, request, runtime);

    const lines = (await readFile(sessionFile, "utf8")).trim().split(/\r?\n/u);
    const appliedLine = lines.map((line) => JSON.parse(line) as { customType?: string; data?: unknown })
      .find((line) => line.customType === "swarm_model_change_continuity_applied");

    expect(appliedLine?.data).toEqual({
      version: 1,
      requestId: "req-1",
      appliedAt: NOW,
      sessionAgentId: "manager-1",
      attachedRuntime: {
        provider: "openai-codex",
        modelId: "gpt-5.4",
        runtimeKind: "pi"
      }
    });
  });

  it("returns startup recovery context with empty block text for recovered-empty policy", async () => {
    const root = await createTempDir("model-change-startup-coordinator-");
    const sessionFile = join(root, "session.jsonl");
    const request = createRequest();
    await writeSession(sessionFile, root, [customLine("swarm_model_change_continuity_request", request, "r1")]);
    const descriptor = createDescriptor({ root, sessionFile });
    const { coordinator, logDebug } = createCoordinator();

    const result = await coordinator.prepareManagerRuntimeCreation(descriptor, "Base prompt");

    expect(result.continuityRequest?.requestId).toBe("req-1");
    expect(result.runtimeCreationOptions).toEqual({
      startupRecoveryContext: {
        reason: "model_change",
        blockText: "",
        requestId: "req-1",
      },
    });
    expect(logDebug).toHaveBeenCalledWith(
      "manager:model_change_continuity:prepare",
      expect.objectContaining({ policy: "recovered_empty" })
    );
  });
});
