import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionGoalStore } from "../goals/session-goal-store.js";
import { SessionPlanStore } from "../planning/session-plan-store.js";
import { savePins } from "../session/message-pins.js";
import { getSessionDir } from "../storage/data-paths.js";
import {
  collectUnconsumedToolEvidenceIds,
  createFreshContextHandler,
  formatFreshContextCheckpoint,
  FRESH_CONTEXT_TOO_LARGE_ERROR,
  isFreshContextBusy,
  resolveFreshCheckpointBudget,
} from "../runtime/fresh-context-checkpoint.js";

function messageEntry(
  id: string,
  message: Record<string, unknown>,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  } as SessionEntry;
}

describe("fresh context checkpoint helper", () => {
  it("budgets the fresh window without subtracting discarded overflow context", async () => {
    const handler = createFreshContextHandler({
      dataDir: join(tmpdir(), "unused"),
      descriptor: { agentId: "s", profileId: "p", role: "manager", managerId: "s" },
      getContextMode: () => "fresh",
      getBudget: () => ({ contextWindow: 32000, maxOutputTokens: 1024, retainedContextTokens: 2000 }),
    });
    const result = await handler({ reason: "overflow", willRetry: true, tokensBefore: 100000, branchEntries: [] });
    expect(result?.summary).toContain("Active overflow obligation");
    expect(result?.tokensBefore).toBe(100000);
  });

  it("rejects busy streaming, tools, and prompt dispatch", () => {
    expect(isFreshContextBusy({ isStreaming: true, promptDispatchPending: false })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: true })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: false, hasInFlightTools: true })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: false, awaitingAgentSettlement: true })).toBe(true);
    expect(isFreshContextBusy({ isStreaming: false, promptDispatchPending: false })).toBe(false);
  });

  it("collects trailing unconsumed tool results and ignores later successful consumers", () => {
    const entries = [
      messageEntry("user-1", { role: "user", content: "start" }),
      messageEntry("assistant-1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1" }],
      }),
      messageEntry("result-1", { role: "toolResult", toolCallId: "call-1", content: "old" }),
      messageEntry("assistant-2", {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "consumed" }],
      }),
      messageEntry("assistant-3", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-2" }],
      }),
      messageEntry("result-2", { role: "toolResult", toolCallId: "call-2", content: "keep" }),
    ];

    expect(collectUnconsumedToolEvidenceIds(entries)).toEqual(["result-2"]);
  });

  it("labels overflow as an active obligation and threshold/manual as historical constraints", () => {
    const overflow = formatFreshContextCheckpoint({
      trigger: "overflow",
      willRetry: true,
      overflowObligation: "Keep going on the oversized first input",
      unconsumedToolEvidence: [{
        entryId: "tool-1",
        toolName: "bash",
        resultPreview: "keep",
        ref: {
          sessionAgentId: "session-1",
          actorAgentId: "session-1",
          entryId: "tool-1",
          sourceVersion: "gen",
          byteOffset: 12,
        },
      }],
    });
    expect(overflow).toContain('history({op:"read",ref:');
    expect(overflow).toContain('"entryId":"tool-1"');
    expect(overflow).toContain("Active overflow obligation");
    expect(overflow).toContain("Keep going on the oversized first input");
    expect(overflow).not.toContain("Do not resurrect completed or aborted work");

    const manual = formatFreshContextCheckpoint({
      trigger: "manual",
      willRetry: false,
      unconsumedToolEvidenceIds: [],
    });
    expect(manual).toContain("Do not resurrect completed or aborted work");
    expect(manual).not.toContain("Active overflow obligation");
  });

  it("builds identical checkpoints from native branch plus current goal/plan/pins", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-fresh-checkpoint-"));
    const descriptor = {
      agentId: "session-1",
      profileId: "profile-1",
      role: "manager" as const,
      managerId: "session-1",
    };
    await new SessionGoalStore({
      dataDir,
      profileId: descriptor.profileId,
      sessionAgentId: descriptor.agentId,
      now: () => "2026-01-01T00:00:00.000Z",
      randomId: () => "goal-1",
    }).create({ objective: "Ship fresh windows" });
    await new SessionPlanStore({
      dataDir,
      profileId: descriptor.profileId,
      sessionAgentId: descriptor.agentId,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }).update({
      explanation: "Keep the current plan",
      plan: [{ id: "step-1", step: "Write tests", status: "in_progress" }],
    });
    await mkdir(getSessionDir(dataDir, descriptor.profileId, descriptor.agentId), { recursive: true });
    await savePins(getSessionDir(dataDir, descriptor.profileId, descriptor.agentId), {
      version: 1,
      pins: {
        "msg-1": {
          pinnedAt: "2026-01-01T00:00:00.000Z",
          role: "user",
          text: "Never leak secrets",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const branch = [
      messageEntry("user-1", { role: "user", content: "old work" }),
      messageEntry("assistant-1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-9" }],
      }),
      messageEntry("result-9", { role: "toolResult", toolCallId: "call-9", content: "evidence" }),
    ];
    const handler = createFreshContextHandler({
      dataDir,
      descriptor,
      getContextMode: () => "fresh",
    });
    const first = await handler({
      reason: "manual",
      willRetry: false,
      branchEntries: branch,
      tokensBefore: 42,
    });
    const second = await handler({
      reason: "manual",
      willRetry: false,
      branchEntries: branch,
      tokensBefore: 42,
    });

    expect(first?.summary).toBe(second?.summary);
    expect(first?.summary).toContain("Ship fresh windows");
    expect(first?.summary).toContain("Write tests");
    expect(first?.summary).toContain("Never leak secrets");
    expect(first?.summary).toContain("unavailable: result-9");
    expect(first?.summary).not.toContain("pendingDeliveries");
    expect(first?.details.forgeContext).toEqual({
      mode: "fresh",
      trigger: "manual",
      willRetry: false,
    });
  });

  it("returns undefined in summary mode without building a checkpoint", async () => {
    const handler = createFreshContextHandler({
      dataDir: join(tmpdir(), "unused"),
      descriptor: {
        agentId: "session-1",
        profileId: "profile-1",
        role: "manager",
        managerId: "session-1",
      },
      getContextMode: () => "summary",
    });
    await expect(handler({
      reason: "manual",
      willRetry: false,
      branchEntries: [],
    })).resolves.toBeUndefined();
  });

  it("refuses a checkpoint that cannot fit remaining model headroom",
    async () => {
      expect(resolveFreshCheckpointBudget({
        contextWindow: 2_000,
        maxOutputTokens: 1_000,
        retainedContextTokens: 1_900,
      })).toBe(0);
      const handler = createFreshContextHandler({
        dataDir: join(tmpdir(), "unused"),
        descriptor: {
          agentId: "session-1",
          profileId: "profile-1",
          role: "manager",
          managerId: "session-1",
          sessionFile: join(tmpdir(), "missing.jsonl"),
        },
        getContextMode: () => "fresh",
        getBudget: () => ({ contextWindow: 2_000, maxOutputTokens: 1_000, retainedContextTokens: 1_900 }),
      });
      await expect(handler({
        reason: "manual",
        willRetry: false,
        branchEntries: [],
        retainedContextTokens: 1_900,
      })).rejects.toThrow(FRESH_CONTEXT_TOO_LARGE_ERROR);
    });
});
