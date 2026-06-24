import { readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHandoffFilePath,
  buildHandoffPrompt,
  buildResumePrompt,
  COMPACTION_GUARD_TEST_TIMEOUT_MS,
  createCompactionGuardRuntime,
  hasCompactionRecord,
} from "../../test-support/compaction-guard-harness.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { DEFAULT_COMPACTION_TIMEOUT_MS } from "../compaction-settings-service.js";

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

  describe("runtime settings provider", () => {
    it("uses configured compaction timeout for smart/manual compaction paths", async () => {
      vi.useFakeTimers();
      const customTimeoutMs = 120_000;
      const { runtime, session } = createCompactionGuardRuntime({
        compactionRuntimeSettingsProvider: createStaticCompactionRuntimeSettingsProvider({
          timeoutMs: customTimeoutMs,
        }),
      });
      session.isStreaming = false;
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const compactPromise = runtime.smartCompact("Preserve unresolved TODOs.");
      await vi.advanceTimersByTimeAsync(customTimeoutMs - 1);
      await Promise.resolve();
      expect(session.compactCalls).toBe(1);
      expect(session.promptCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await compactPromise;

      expect(result.compacted).toBe(false);
      expect(result.reason).toContain("smart_compact_compact timed out");
    });

    it("defaults to persisted compaction timeout when no provider override is supplied in tests", () => {
      const { runtime } = createCompactionGuardRuntime({
        compactionRuntimeSettingsProvider: createStaticCompactionRuntimeSettingsProvider({
          timeoutMs: DEFAULT_COMPACTION_TIMEOUT_MS,
        }),
      });

      expect((runtime as never as { getCompactionTimeoutMs: () => number }).getCompactionTimeoutMs()).toBe(
        DEFAULT_COMPACTION_TIMEOUT_MS,
      );
    });
  });

  describe("recovery contract (Phase 3)", () => {
    it("context guard compact timeout must not resume without a compaction record", async () => {
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

      await vi.advanceTimersByTimeAsync(COMPACTION_GUARD_TEST_TIMEOUT_MS);
      await guardPromise;

      expect(hasCompactionRecord(session.entries)).toBe(false);
      expect(session.promptCalls).toHaveLength(1);
      expect(session.promptCalls[0]).toBe(buildHandoffPrompt(buildHandoffFilePath(runtime.descriptor)));
    });

    it("smartCompact compact timeout must not resume after failure", async () => {
      vi.useFakeTimers();
      const { runtime, session } = createCompactionGuardRuntime();
      session.isStreaming = false;
      session.compactImpl = async () => {
        await new Promise<void>(() => {});
      };

      const compactPromise = runtime.smartCompact("Preserve unresolved TODOs.");
      await vi.advanceTimersByTimeAsync(COMPACTION_GUARD_TEST_TIMEOUT_MS);
      const result = await compactPromise;

      expect(result.compacted).toBe(false);
      expect(session.promptCalls).toHaveLength(1);
      expect(session.promptCalls[0]).toBe(buildHandoffPrompt(buildHandoffFilePath(runtime.descriptor)));
    });

    it("handleAutoCompactionEndEvent aborted without error must not report auto_compaction_succeeded", async () => {
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
      expect(runtimeErrors.some((entry) => entry.details?.recoveryStage === "auto_compaction_aborted")).toBe(true);
    });

    it("blocks mid-turn context guard for 60s after failed automatic compaction", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const { runtime, session } = createCompactionGuardRuntime();
      session.isStreaming = true;
      session.contextUsage = {
        tokens: 176_000,
        contextWindow: 200_000,
        percent: 88,
      };

      const runGuardSpy = vi
        .spyOn(runtime as never as { runContextGuard: (usage: unknown) => Promise<void> }, "runContextGuard")
        .mockResolvedValue(undefined);

      await (runtime as never as {
        handleAutoCompactionEndEvent: (event: unknown) => Promise<void>;
      }).handleAutoCompactionEndEvent({
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: true,
        willRetry: false,
      });

      vi.setSystemTime(1_003_000);
      (runtime as never as { checkContextBudget: () => void }).checkContextBudget();
      expect(runGuardSpy).not.toHaveBeenCalled();

      vi.setSystemTime(1_050_000);
      (runtime as never as { checkContextBudget: () => void }).checkContextBudget();
      expect(runGuardSpy).not.toHaveBeenCalled();

      vi.setSystemTime(1_060_001);
      (runtime as never as { checkContextBudget: () => void }).checkContextBudget();
      expect(runGuardSpy).toHaveBeenCalledTimes(1);
    });

    it("failed context guard must retain handoff artifact instead of deleting it", async () => {
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

      await vi.advanceTimersByTimeAsync(COMPACTION_GUARD_TEST_TIMEOUT_MS);
      await guardPromise;

      expect(hasCompactionRecord(session.entries)).toBe(false);
      expect(rmMock).not.toHaveBeenCalledWith(handoffPath, { force: true });
    });

    it("handleAutoCompactionEndEvent success path requires compaction_start snapshot and a new record", async () => {
      const { runtime, session, runtimeErrors } = createCompactionGuardRuntime();
      session.entries.push({ type: "compaction", id: "historical-compaction" });

      await (runtime as never as {
        handleAutoCompactionEndEvent: (event: unknown) => Promise<void>;
      }).handleAutoCompactionEndEvent({
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: false,
        willRetry: false,
      });

      expect(runtimeErrors.some((entry) => entry.details?.recoveryStage === "auto_compaction_succeeded")).toBe(false);
      expect(runtimeErrors.some((entry) => entry.details?.missingCompactionStartSnapshot === true)).toBe(true);
    });
  });
});
