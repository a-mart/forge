import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CortexReviewRunScope } from "@forge/protocol";
import { getCortexReviewRunsPath } from "../data-paths.js";
import {
  buildCortexReviewRunRequestText,
  buildCortexReviewRunScopeLabel,
  buildLiveCortexReviewRunRecord,
  parseCortexReviewRunScopeFromText,
  parseScheduledTaskEnvelope,
  readStoredCortexReviewRuns
} from "../cortex-review-runs.js";

describe("cortex-review-runs", () => {
  it("parses scheduled task envelopes and extracts the review body", () => {
    expect(
      parseScheduledTaskEnvelope(
        [
          "[Scheduled Task: Nightly Review]",
          '[scheduleContext] {"scheduleId":"sched-1"}',
          "",
          "Review all sessions that need attention"
        ].join("\n")
      )
    ).toEqual({
      scheduleName: "Nightly Review",
      scheduleId: "sched-1",
      body: "Review all sessions that need attention"
    });
  });

  it("parses review scopes from manual review text", () => {
    expect(parseCortexReviewRunScopeFromText("Review all sessions that need attention")).toEqual({ mode: "all" });
    expect(parseCortexReviewRunScopeFromText("Review session alpha/alpha--s1 (memory, feedback freshness)")).toEqual({
      mode: "session",
      profileId: "alpha",
      sessionId: "alpha--s1",
      axes: ["memory", "feedback"]
    });
  });

  it("builds scope labels and request text consistently", () => {
    const scope: CortexReviewRunScope = { mode: "session", profileId: "alpha", sessionId: "alpha--s1", axes: ["memory", "feedback"] };
    expect(buildCortexReviewRunScopeLabel(scope)).toBe("alpha/alpha--s1 (memory, feedback)");
    expect(buildCortexReviewRunRequestText(scope)).toBe("Review session alpha/alpha--s1 (memory, feedback freshness)");
  });

  it("surfaces interrupted runs without misclassifying them as completed", () => {
    expect(buildLiveCortexReviewRunRecord({
      stored: {
        runId: "review-interrupted",
        trigger: "manual",
        scope: { mode: "session", profileId: "alpha", sessionId: "alpha--s1", axes: ["memory"] },
        scopeLabel: "alpha/alpha--s1 (memory)",
        requestText: "Review session alpha/alpha--s1 (memory freshness)",
        requestedAt: "2026-03-17T01:00:00.000Z",
        sessionAgentId: "cortex--s2",
        interruptedAt: "2026-03-17T01:05:00.000Z",
        interruptionReason: "Interrupted by backend restart; request requeued automatically."
      },
      sessionDescriptor: {
        agentId: "cortex--s2",
        managerId: "cortex--s2",
        displayName: "Review Run",
        role: "manager",
        status: "idle",
        createdAt: "2026-03-17T01:00:00.000Z",
        updatedAt: "2026-03-17T01:05:00.000Z",
        cwd: "/tmp",
        model: { provider: "openai", modelId: "gpt-test", thinkingLevel: "medium" },
        sessionFile: "/tmp/cortex--s2.jsonl"
      },
      activeWorkerCount: 0
    }).status).toBe("interrupted");
  });

  it("filters malformed stored runs when reading the ledger", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-runs-"));
    const reviewRunsPath = getCortexReviewRunsPath(dataDir);
    await mkdir(dirname(reviewRunsPath), { recursive: true });
    await writeFile(
      reviewRunsPath,
      `${JSON.stringify({
        version: 1,
        runs: [
          {
            runId: "review-valid",
            trigger: "manual",
            scope: { mode: "session", profileId: "alpha", sessionId: "alpha--s1", axes: ["memory"] },
            scopeLabel: "alpha/alpha--s1 (memory)",
            requestText: "Review session alpha/alpha--s1 (memory freshness)",
            requestedAt: "2026-03-17T01:00:00.000Z",
            sessionAgentId: "cortex--s2"
          },
          {
            runId: "review-invalid-trigger",
            trigger: "api",
            scope: { mode: "all" },
            scopeLabel: "All sessions",
            requestText: "Review all sessions that need attention",
            requestedAt: "2026-03-17T01:01:00.000Z",
            sessionAgentId: null
          },
          {
            runId: "review-invalid-scope",
            trigger: "manual",
            scope: { mode: "session", profileId: "alpha" },
            scopeLabel: "broken",
            requestText: "broken",
            requestedAt: "2026-03-17T01:02:00.000Z",
            sessionAgentId: null
          }
        ]
      }, null, 2)}\n`,
      "utf8"
    );

    await expect(readStoredCortexReviewRuns(dataDir)).resolves.toEqual([
      {
        runId: "review-valid",
        trigger: "manual",
        scope: { mode: "session", profileId: "alpha", sessionId: "alpha--s1", axes: ["memory"] },
        scopeLabel: "alpha/alpha--s1 (memory)",
        requestText: "Review session alpha/alpha--s1 (memory freshness)",
        requestedAt: "2026-03-17T01:00:00.000Z",
        sessionAgentId: "cortex--s2"
      }
    ]);
  });
});
