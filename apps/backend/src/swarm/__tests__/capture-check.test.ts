import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCaptureJudgePrompt,
  countUserTurnsSinceWatermark,
  evaluateCaptureCadence,
  invokeCaptureJudge,
  readCaptureDeltaFromSessionFile,
  runCaptureCheckFork,
} from "../capture-check.js";

describe("capture-check cascade", () => {
  it.each([
    [{ enabled: false, userTurnsSinceWatermark: 8 }, { shouldJudge: false, skippedReason: "knowledge_v2_disabled" }],
    [{ enabled: true, userTurnsSinceWatermark: 0 }, { shouldJudge: false, skippedReason: "no_pending_user_turns" }],
    [{ enabled: true, userTurnsSinceWatermark: 8 }, { shouldJudge: true, reason: "turns" }],
    [{ enabled: true, userTurnsSinceWatermark: 1, trigger: "idle", idleGapMs: 300_000 }, { shouldJudge: true, reason: "idle" }],
    [{ enabled: true, userTurnsSinceWatermark: 1, trigger: "compaction" }, { shouldJudge: true, reason: "compaction" }],
    [{ enabled: true, userTurnsSinceWatermark: 1, trigger: "feedback" }, { shouldForkDirectly: true, reason: "feedback" }],
    [{ enabled: true, userTurnsSinceWatermark: 8, dailyForksUsed: 3 }, { shouldJudge: false, skippedReason: "daily_fork_cap" }],
  ] as const)("evaluates cadence case %#", (input, expected) => {
    expect(evaluateCaptureCadence(input)).toMatchObject(expected);
  });

  it("builds a stripped judge prompt and parses mock model output", async () => {
    const sessionFile = join(process.cwd(), "src", "swarm", "__tests__", "fixtures", "capture-check-session.jsonl");
    const messages = await readCaptureDeltaFromSessionFile(sessionFile, {
      lastCaptureCheckAt: "2026-07-05T12:00:30.000Z",
    });
    expect(countUserTurnsSinceWatermark(messages)).toBe(1);
    const prompt = buildCaptureJudgePrompt(messages);
    expect(prompt).toContain("USER: Correction:");
    expect(prompt).toContain("ASSISTANT: I will treat it as project-scoped.");
    expect(prompt).not.toContain("bulk tool output");

    const result = await invokeCaptureJudge(
      { complete: async (receivedPrompt) => `YES: ${receivedPrompt.includes("Correction") ? "project scope correction" : ""}` },
      messages,
    );
    expect(result).toEqual({
      shouldFork: true,
      pointer: "project scope correction",
      raw: "YES: project scope correction",
    });
  });

  it("runs a direct fork-runner integration against the fixture session mechanics", async () => {
    const calls: string[] = [];
    const result = await runCaptureCheckFork({
      enabled: true,
      sourceAgentId: "manager",
      fromMessageId: "m4",
      judgePointer: "project scope correction",
      adapter: {
        async forkSession(sourceAgentId, options) {
          calls.push(`fork:${sourceAgentId}:${options.fromMessageId}`);
          return { sessionAgentId: "capture-fork" };
        },
        async sendRestrictedTurn(forkedAgentId, message, options) {
          calls.push(`send:${forkedAgentId}:${options.allowedTools.join(",")}:${options.reason}`);
          expect(message).toContain("Judge hint: project scope correction");
        },
        async discardFork(forkedAgentId) {
          calls.push(`discard:${forkedAgentId}`);
        },
      },
    });
    expect(result).toEqual({ status: "completed", forkedAgentId: "capture-fork" });
    expect(calls).toEqual([
      "fork:manager:m4",
      "send:capture-fork:knowledge,save_learning:capture_check",
      "discard:capture-fork",
    ]);
  });
});
