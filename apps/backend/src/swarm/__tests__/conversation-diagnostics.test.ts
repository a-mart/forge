import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_HISTORY_CACHE_STATE_METRIC } from "../../stats/sidebar-perf-metrics.js";
import type { SidebarPerfRecorder } from "../../stats/sidebar-perf-types.js";
import {
  createConversationHistoryDiagnostics,
  mergeDiagnosticDetails,
  recordConversationHistoryDiagnostics,
  sumOptionalNumbers
} from "../session/conversation-diagnostics.js";

describe("conversation diagnostics", () => {
  it("creates diagnostics with defaults and optional passthrough fields", () => {
    expect(
      createConversationHistoryDiagnostics({
        cacheState: "absent",
        historySource: "full_parse",
        coldLoad: true
      })
    ).toEqual({
      cacheState: "absent",
      historySource: "full_parse",
      coldLoad: true,
      fsReadOps: 0,
      fsReadBytes: 0,
      sessionFileBytes: undefined,
      cacheFileBytes: undefined,
      persistedEntryCount: undefined,
      cachedEntryCount: undefined,
      sessionSummaryBytesScanned: undefined,
      cacheReadMs: undefined,
      sessionSummaryReadMs: undefined,
      fastPathUsed: false,
      detail: null
    });

    expect(
      createConversationHistoryDiagnostics({
        cacheState: "hit",
        historySource: "cache_hit",
        coldLoad: false,
        fsReadOps: 0,
        fsReadBytes: 42,
        sessionFileBytes: 100,
        cacheFileBytes: 50,
        persistedEntryCount: 7,
        cachedEntryCount: 6,
        sessionSummaryBytesScanned: 80,
        cacheReadMs: 1.5,
        sessionSummaryReadMs: 2.5,
        fastPathUsed: true,
        detail: "cache_valid"
      })
    ).toEqual({
      cacheState: "hit",
      historySource: "cache_hit",
      coldLoad: false,
      fsReadOps: 0,
      fsReadBytes: 42,
      sessionFileBytes: 100,
      cacheFileBytes: 50,
      persistedEntryCount: 7,
      cachedEntryCount: 6,
      sessionSummaryBytesScanned: 80,
      cacheReadMs: 1.5,
      sessionSummaryReadMs: 2.5,
      fastPathUsed: true,
      detail: "cache_valid"
    });
  });

  it("merges diagnostic detail strings with trimming, splitting, de-duping, and stable order", () => {
    expect(mergeDiagnosticDetails(null, undefined, "", "   ")).toBeNull();
    expect(
      mergeDiagnosticDetails(
        " first ; second; third ",
        undefined,
        "second; fourth",
        null,
        " first ; fifth "
      )
    ).toBe("first; second; third; fourth; fifth");
  });

  it("sums only numeric optional values and treats zero as numeric", () => {
    expect(sumOptionalNumbers(undefined, undefined)).toBeUndefined();
    expect(sumOptionalNumbers(0, undefined)).toBe(0);
    expect(sumOptionalNumbers(undefined, 1.25, 0, 2.75)).toBe(4);
  });

  it("records perf metric labels and fields while omitting null detail as undefined", () => {
    const increment = vi.fn();
    const perf = {
      increment,
      recordDuration: vi.fn(),
      readSummary: vi.fn(),
      readRecentSlowEvents: vi.fn()
    } satisfies SidebarPerfRecorder;

    recordConversationHistoryDiagnostics(
      perf,
      "agent-1",
      createConversationHistoryDiagnostics({
        cacheState: "hit",
        historySource: "cache_hit",
        coldLoad: true,
        fsReadOps: 0,
        fsReadBytes: 10,
        sessionFileBytes: 20,
        cacheFileBytes: 30,
        persistedEntryCount: 2,
        cachedEntryCount: 1,
        sessionSummaryBytesScanned: 40,
        cacheReadMs: 1,
        sessionSummaryReadMs: 2,
        detail: null,
        fastPathUsed: false
      })
    );

    expect(increment).toHaveBeenCalledWith(SIDEBAR_HISTORY_CACHE_STATE_METRIC, {
      labels: {
        cacheState: "hit",
        historySource: "cache_hit"
      },
      fields: {
        agentId: "agent-1",
        coldLoad: true,
        fsReadOps: 0,
        fsReadBytes: 10,
        sessionFileBytes: 20,
        cacheFileBytes: 30,
        persistedEntryCount: 2,
        cachedEntryCount: 1,
        sessionSummaryBytesScanned: 40,
        cacheReadMs: 1,
        sessionSummaryReadMs: 2,
        detail: undefined,
        fastPathUsed: false
      }
    });
  });
});
