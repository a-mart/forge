import { readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHandoffFilePath,
  buildHandoffPrompt,
  buildResumePrompt,
  createCompactionGuardRuntime,
  hasCompactionRecord,
} from "../../test-support/compaction-guard-harness.js";

const resizeImageIfNeededMock = vi.hoisted(() =>
  vi.fn(async (data: string, mimeType: string) => ({
    data,
    mimeType,
  })),
);

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock("../image-utils.js", () => ({
  resizeImageIfNeeded: (...args: unknown[]) => resizeImageIfNeededMock(...args),
}));

const readFileMock = vi.mocked(readFile);
const rmMock = vi.mocked(rm);

describe("compaction stability characterization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resizeImageIfNeededMock.mockImplementation(async (data: string, mimeType: string) => ({
      data,
      mimeType,
    }));
    readFileMock.mockResolvedValue("## Current Task\nKeep going\n");
    rmMock.mockResolvedValue(undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("baseline (current behavior)", () => {
    it("context guard compact timeout reports failure and still resumes", async () => {
      vi.useFakeTimers();
      const { runtime, session, runtimeErrors } = createCompactionGuardRuntime();
      session.contextUsage = {
        tokens: 176_000,
        contextWindow: 200_000,
        percent: 88,
      };
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const guardPromise = (runtime as never as { runContextGuard: (usage: unknown) => Promise<void> }).runContextGuard({
        tokens: 172_000,
        contextWindow: 200_000,
        percent: 86,
      });

      await vi.advanceTimersByTimeAsync(180_000);
      await guardPromise;

      expect(session.compactCalls).toBe(1);
      expect(hasCompactionRecord(session.entries)).toBe(false);
      expect(session.promptCalls).toHaveLength(2);
      expect(runtimeErrors.some((entry) => entry.details?.stage === "compaction_failed")).toBe(true);
    });

    it("smartCompact compact timeout returns not-reduced but still resumes by default", async () => {
      vi.useFakeTimers();
      const { runtime, session } = createCompactionGuardRuntime();
      session.isStreaming = false;
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const compactPromise = runtime.smartCompact("Preserve unresolved TODOs.");
      await vi.advanceTimersByTimeAsync(180_000);
      const result = await compactPromise;

      expect(result).toEqual({
        compacted: false,
        reason: expect.stringContaining("smart_compact_compact timed out"),
      });
      expect(hasCompactionRecord(session.entries)).toBe(false);
      expect(session.promptCalls).toHaveLength(2);
      expect(session.promptCalls[1]).toBe(buildResumePrompt("## Current Task\nKeep going"));
    });

    it("handleAutoCompactionEndEvent treats aborted/no-error compaction_end as success today", async () => {
      const { runtime, runtimeErrors } = createCompactionGuardRuntime();

      await (runtime as never as {
        handleAutoCompactionEndEvent: (event: unknown) => Promise<void>;
      }).handleAutoCompactionEndEvent({
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: true,
        willRetry: false,
      });

      expect(runtimeErrors.some((entry) => entry.details?.recoveryStage === "auto_compaction_succeeded")).toBe(true);
    });

    it("context guard deletes handoff file after compact timeout failure", async () => {
      vi.useFakeTimers();
      const { runtime, session } = createCompactionGuardRuntime();
      session.contextUsage = {
        tokens: 176_000,
        contextWindow: 200_000,
        percent: 88,
      };
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const handoffPath = buildHandoffFilePath(runtime.descriptor);
      const guardPromise = (runtime as never as { runContextGuard: (usage: unknown) => Promise<void> }).runContextGuard({
        tokens: 172_000,
        contextWindow: 200_000,
        percent: 86,
      });

      await vi.advanceTimersByTimeAsync(180_000);
      await guardPromise;

      expect(rmMock).toHaveBeenCalledWith(handoffPath, { force: true });
    });
  });

  describe("target contract (pending runtime fixes)", () => {
    it.fails("context guard compact timeout must not resume without a compaction record", async () => {
      vi.useFakeTimers();
      const { runtime, session } = createCompactionGuardRuntime();
      session.contextUsage = {
        tokens: 176_000,
        contextWindow: 200_000,
        percent: 88,
      };
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const guardPromise = (runtime as never as { runContextGuard: (usage: unknown) => Promise<void> }).runContextGuard({
        tokens: 172_000,
        contextWindow: 200_000,
        percent: 86,
      });

      await vi.advanceTimersByTimeAsync(180_000);
      await guardPromise;

      expect(hasCompactionRecord(session.entries)).toBe(false);
      expect(session.promptCalls).toHaveLength(1);
      expect(session.promptCalls[0]).toBe(buildHandoffPrompt(buildHandoffFilePath(runtime.descriptor)));
    });

    it.fails("smartCompact compact timeout must not resume after failure", async () => {
      vi.useFakeTimers();
      const { runtime, session } = createCompactionGuardRuntime();
      session.isStreaming = false;
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const compactPromise = runtime.smartCompact("Preserve unresolved TODOs.");
      await vi.advanceTimersByTimeAsync(180_000);
      const result = await compactPromise;

      expect(result.compacted).toBe(false);
      expect(session.promptCalls).toHaveLength(1);
      expect(session.promptCalls[0]).toBe(buildHandoffPrompt(buildHandoffFilePath(runtime.descriptor)));
    });

    it.fails("handleAutoCompactionEndEvent aborted without error must not report auto_compaction_succeeded", async () => {
      const { runtime, runtimeErrors } = createCompactionGuardRuntime();

      await (runtime as never as {
        handleAutoCompactionEndEvent: (event: unknown) => Promise<void>;
      }).handleAutoCompactionEndEvent({
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: true,
        willRetry: false,
      });

      expect(runtimeErrors.some((entry) => entry.details?.recoveryStage === "auto_compaction_succeeded")).toBe(false);
    });

    it.fails("failed context guard must retain handoff artifact instead of deleting it", async () => {
      vi.useFakeTimers();
      const { runtime, session } = createCompactionGuardRuntime();
      session.contextUsage = {
        tokens: 176_000,
        contextWindow: 200_000,
        percent: 88,
      };
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const handoffPath = buildHandoffFilePath(runtime.descriptor);
      const guardPromise = (runtime as never as { runContextGuard: (usage: unknown) => Promise<void> }).runContextGuard({
        tokens: 172_000,
        contextWindow: 200_000,
        percent: 86,
      });

      await vi.advanceTimersByTimeAsync(180_000);
      await guardPromise;

      expect(hasCompactionRecord(session.entries)).toBe(false);
      expect(rmMock).not.toHaveBeenCalledWith(handoffPath, { force: true });
    });
  });
});
