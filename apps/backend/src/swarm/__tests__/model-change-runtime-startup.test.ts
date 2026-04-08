import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createModelChangeContinuityApplied,
  createModelChangeContinuityRequest
} from "../runtime/model-change-continuity.js";
import { resolvePendingModelChangeRuntimeStartup } from "../runtime/model-change-runtime-startup.js";

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

describe("resolvePendingModelChangeRuntimeStartup", () => {
  it("selects the latest matching pending request and builds recovery context from durable session data", async () => {
    const root = await createTempDir("model-change-runtime-startup-");
    const sessionFile = join(root, "session.jsonl");

    const stale = createModelChangeContinuityRequest({
      requestId: "req-stale",
      createdAt: "2026-04-08T00:00:00.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "claude-sdk", modelId: "claude-opus-4-6", thinkingLevel: "high" },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" }
    });
    const matching = createModelChangeContinuityRequest({
      requestId: "req-match",
      createdAt: "2026-04-08T00:00:01.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "claude-sdk", modelId: "claude-opus-4-6", thinkingLevel: "high" },
      targetModel: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "high" }
    });
    const applied = createModelChangeContinuityApplied({
      requestId: stale.requestId,
      appliedAt: "2026-04-08T00:00:02.000Z",
      sessionAgentId: "manager-1",
      attachedRuntime: { provider: stale.targetModel.provider, modelId: stale.targetModel.modelId }
    });

    await writeFile(
      sessionFile,
      [
        sessionHeader(root),
        customLine("swarm_model_change_continuity_request", stale, "r1"),
        customLine("swarm_model_change_continuity_request", matching, "r2"),
        customLine("swarm_model_change_continuity_applied", applied, "a1"),
        customLine(
          "swarm_claude_compaction_summary",
          {
            generationId: 1,
            summary: "## Claude Summary\nKeep the migration non-destructive.",
            compactedAt: "2026-04-08T00:00:03.000Z"
          },
          "c1"
        ),
        customLine(
          "swarm_conversation_entry",
          {
            type: "conversation_message",
            agentId: "manager-1",
            role: "user",
            text: "Continue the migration",
            timestamp: "2026-04-08T00:00:04.000Z",
            source: "user_input"
          },
          "e1"
        ),
        customLine(
          "swarm_conversation_entry",
          {
            type: "agent_message",
            agentId: "manager-1",
            timestamp: "2026-04-08T00:00:05.000Z",
            source: "agent_to_agent",
            fromAgentId: "backend-specialist",
            toAgentId: "manager-1",
            text: "Attached logs.",
            attachmentCount: 3
          },
          "e2"
        )
      ].join("\n") + "\n",
      "utf8"
    );

    const result = await resolvePendingModelChangeRuntimeStartup({
      descriptor: {
        agentId: "manager-1",
        role: "manager",
        sessionFile
      },
      targetModel: {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        thinkingLevel: "high"
      },
      existingPrompt: "Base system prompt",
      modelContextWindow: 200_000
    });

    expect(result.policy).toBe("recovered");
    expect(result.request?.requestId).toBe("req-match");
    expect(result.recoveryContext?.blockText).toContain("# Recovered Forge Conversation Context");
    expect(result.recoveryContext?.blockText).toContain("[Claude compaction summary]");
    expect(result.recoveryContext?.blockText).toContain("User: Continue the migration");
    expect(result.recoveryContext?.blockText).toContain(
      "Worker/Agent message (backend-specialist): Attached logs. [3 attachments omitted]"
    );
  });

  it("returns the pending request without recovery context for conservative pi-to-pi switches", async () => {
    const root = await createTempDir("model-change-runtime-startup-");
    const sessionFile = join(root, "session.jsonl");
    const request = createModelChangeContinuityRequest({
      requestId: "req-pi",
      createdAt: "2026-04-08T00:00:00.000Z",
      sessionAgentId: "manager-1",
      sourceModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" },
      targetModel: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "high" }
    });

    request.sourceModel.runtimeKind = "pi";
    request.targetModel.runtimeKind = "pi";

    await writeFile(
      sessionFile,
      [sessionHeader(root), customLine("swarm_model_change_continuity_request", request, "r1")].join("\n") + "\n",
      "utf8"
    );

    const result = await resolvePendingModelChangeRuntimeStartup({
      descriptor: {
        agentId: "manager-1",
        role: "manager",
        sessionFile
      },
      targetModel: {
        provider: request.targetModel.provider,
        modelId: request.targetModel.modelId,
        thinkingLevel: request.targetModel.thinkingLevel
      },
      existingPrompt: "Base system prompt"
    });

    expect(result.policy).toBe("skip_pi_to_pi");
    expect(result.request?.requestId).toBe("req-pi");
    expect(result.recoveryContext).toBeUndefined();
  });
});
