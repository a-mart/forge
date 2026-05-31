import { describe, expect, it } from "vitest";
import {
  CODEX_DETAIL_MAX_ROWS_PER_TURN,
  buildCodexItemDisplayPayload,
  extractStableItemId,
  finalizeCodexDetailItemsForTurnEnd,
  normalizeCodexDetailNotification,
  safeJson,
  shouldAcceptCodexDetailNotification,
} from "../codex-app-server/codex-app-server-event-normalizer.js";
import type { CodexSidecarActiveTurn } from "../codex-app-server/types.js";

function createActiveTurn(overrides: Partial<CodexSidecarActiveTurn> = {}): CodexSidecarActiveTurn {
  return {
    turnId: "turn-1",
    correlationId: "corr-1",
    userText: "hello",
    startedAt: "2026-05-30T00:00:00.000Z",
    assistantText: "",
    assistantMessageEmitted: false,
    suppressed: false,
    turnEpoch: 1,
    ...overrides,
  };
}

describe("codex app-server event normalizer", () => {
  it("extracts stable item ids from lifecycle and delta notifications", () => {
    expect(extractStableItemId({ itemId: "item-delta" })).toBe("item-delta");
    expect(extractStableItemId({ item: { id: "item-life" } })).toBe("item-life");
  });

  it("redacts secret-looking values before serialization", () => {
    const serialized = safeJson({
      Authorization: "Bearer abc.def.ghi",
      apiKey: "sk-live-secret-key-value",
      command: "echo ok",
    });

    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("sk-live-secret-key-value");
    expect(serialized).not.toContain("Bearer abc");
  });

  it("builds whitelisted command display payloads only", () => {
    const payload = buildCodexItemDisplayPayload({
      type: "commandExecution",
      id: "cmd-1",
      command: "pnpm test",
      status: "inProgress",
      aggregatedOutput: "Authorization: Bearer secret-token",
    });

    expect(payload?.command).toBe("pnpm test");
    expect(JSON.stringify(payload)).not.toContain("secret-token");
  });

  it("rejects turnless detail notifications unless item is already tracked", () => {
    const activeTurn = createActiveTurn();
    expect(
      shouldAcceptCodexDetailNotification(activeTurn, undefined, "orphan-item"),
    ).toBe(false);

    activeTurn.codexItemsById = new Map([
      [
        "tracked-item",
        {
          itemId: "tracked-item",
          turnId: "turn-1",
          itemType: "commandExecution",
          displayKind: "command",
          toolName: "codex_command",
          toolCallId: "tracked-item",
          startedAt: activeTurn.startedAt,
        },
      ],
    ]);

    expect(
      shouldAcceptCodexDetailNotification(activeTurn, undefined, "tracked-item"),
    ).toBe(true);
  });

  it("emits grouped start/end rows with stable toolCallId", () => {
    const activeTurn = createActiveTurn();

    const startRows = normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "echo hi",
          cwd: "/tmp",
          status: "inProgress",
          commandActions: [],
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    expect(startRows).toHaveLength(1);
    expect(startRows[0]?.kind).toBe("tool_execution_start");
    expect(startRows[0]?.toolCallId).toBe("cmd-1");

    const endRows = normalizeCodexDetailNotification({
      method: "item/completed",
      params: {
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "echo hi",
          cwd: "/tmp",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "hi",
          exitCode: 0,
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:02.000Z",
      nowMs: 2_000,
    });

    expect(endRows).toHaveLength(1);
    expect(endRows[0]?.kind).toBe("tool_execution_end");
    expect(endRows[0]?.toolCallId).toBe("cmd-1");
  });

  it("emits tool_execution_update rows for tracked progress notifications without item payloads", () => {
    const activeTurn = createActiveTurn();

    normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "echo hi",
          cwd: "/tmp",
          status: "inProgress",
          commandActions: [],
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "forge",
          tool: "search",
          status: "inProgress",
          arguments: {},
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    const commandUpdate = normalizeCodexDetailNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        turnId: "turn-1",
        itemId: "cmd-1",
        delta: "partial output",
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:02.000Z",
      nowMs: 2_500,
    });

    const mcpUpdate = normalizeCodexDetailNotification({
      method: "item/mcpToolCall/progress",
      params: {
        turnId: "turn-1",
        itemId: "mcp-1",
        message: "Searching…",
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:03.000Z",
      nowMs: 3_500,
    });

    expect(commandUpdate).toEqual([
      expect.objectContaining({
        kind: "tool_execution_update",
        toolCallId: "cmd-1",
        toolName: "codex_command",
      }),
    ]);
    expect(mcpUpdate).toEqual([
      expect.objectContaining({
        kind: "tool_execution_update",
        toolCallId: "mcp-1",
        toolName: "codex_mcp_tool",
      }),
    ]);
  });

  it("ignores orphan progress updates and mismatched turn ids", () => {
    const activeTurn = createActiveTurn();

    const orphan = normalizeCodexDetailNotification({
      method: "item/mcpToolCall/progress",
      params: {
        turnId: "turn-1",
        itemId: "missing-item",
        message: "working",
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });
    expect(orphan).toEqual([]);

    normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "cmd-2",
          type: "commandExecution",
          command: "echo",
          cwd: "/tmp",
          status: "inProgress",
          commandActions: [],
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    const mismatched = normalizeCodexDetailNotification({
      method: "item/commandExecution/outputDelta",
      params: {
        turnId: "turn-2",
        itemId: "cmd-2",
        delta: "stale",
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:02.000Z",
      nowMs: 2_000,
    });
    expect(mismatched).toEqual([]);
  });

  it("default-denies reasoning items", () => {
    const activeTurn = createActiveTurn();
    const rows = normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "reason-1",
          type: "reasoning",
          content: ["hidden"],
          summary: ["also hidden"],
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    expect(rows).toEqual([]);
  });

  it("enforces per-turn row caps", () => {
    const activeTurn = createActiveTurn();
    activeTurn.codexDetailCounters = {
      emittedRowsThisTurn: CODEX_DETAIL_MAX_ROWS_PER_TURN,
      droppedRowsThisTurn: 0,
      emittedBytesThisTurn: 0,
    };

    const rows = normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "cmd-cap",
          type: "commandExecution",
          command: "echo capped",
          cwd: "/tmp",
          status: "inProgress",
          commandActions: [],
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolCallId).toBe("codex-cap-turn-1");
    expect(activeTurn.codexDetailCounters?.droppedRowsThisTurn).toBeGreaterThan(0);
  });

  it("marks cancelled turn finalization rows with cancelled status", () => {
    const activeTurn = createActiveTurn();
    normalizeCodexDetailNotification({
      method: "item/started",
      params: {
        turnId: "turn-1",
        item: {
          id: "cmd-open",
          type: "commandExecution",
          command: "sleep 1",
          cwd: "/tmp",
          status: "inProgress",
          commandActions: [],
        },
      },
      activeTurn,
      nowIso: "2026-05-30T00:00:01.000Z",
      nowMs: 1_000,
    });

    const rows = finalizeCodexDetailItemsForTurnEnd(activeTurn, "cancelled");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
    expect(rows[0]?.isError).toBe(false);
    expect(rows[0]?.text).toContain('"status":"cancelled"');
  });
});
