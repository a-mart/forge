import { describe, expect, it } from "vitest";
import {
  dispatchCodexAppServerNotification,
  shouldAcceptTurnlessItemNotification,
  shouldIgnoreCodexNotification,
} from "../codex-app-server/codex-app-server-events.js";
import type { CodexSidecarActiveTurn } from "../codex-app-server/types.js";

describe("codex app-server notification dispatch", () => {
  const activeTurn: CodexSidecarActiveTurn = {
    turnId: "turn-1",
    correlationId: "corr-1",
    userText: "hello",
    startedAt: "2026-05-30T00:00:00.000Z",
    assistantText: "",
    assistantMessageEmitted: false,
    suppressed: false,
    turnEpoch: 1,
  };

  const dispatchContext = {
    sidecarAgentId: "mgr--codex",
    managerAgentId: "mgr",
    activeTurn,
    openCompletionGraceToken: 1,
  };

  it("ignores notifications for suppressed or mismatched turns", () => {
    expect(shouldIgnoreCodexNotification(undefined, "turn-1")).toBe(true);
    expect(shouldIgnoreCodexNotification({ ...activeTurn, suppressed: true }, "turn-1")).toBe(true);
    expect(shouldIgnoreCodexNotification(activeTurn, "turn-2")).toBe(true);
    expect(shouldIgnoreCodexNotification(activeTurn, "turn-1")).toBe(false);
  });

  it("only accepts turnless item/completed for the open completion grace token", () => {
    expect(
      shouldAcceptTurnlessItemNotification(activeTurn, 1, "item/agentMessage/delta"),
    ).toBe(false);
    expect(
      shouldAcceptTurnlessItemNotification(activeTurn, 1, "item/completed"),
    ).toBe(false);
    expect(
      shouldAcceptTurnlessItemNotification(
        {
          ...activeTurn,
          turnCompletedPending: true,
          graceItemAcceptOpen: true,
          completionGraceToken: 1,
        },
        1,
        "item/completed",
      ),
    ).toBe(true);
    expect(
      shouldAcceptTurnlessItemNotification(
        {
          ...activeTurn,
          turnCompletedPending: true,
          graceItemAcceptOpen: true,
          completionGraceToken: 1,
        },
        2,
        "item/completed",
      ),
    ).toBe(false);
    expect(
      shouldAcceptTurnlessItemNotification(
        {
          ...activeTurn,
          turnCompletedPending: true,
          graceItemAcceptOpen: true,
          completionGraceToken: 2,
        },
        2,
        "item/completed",
      ),
    ).toBe(true);
  });

  it("accumulates assistant deltas and completes turn", async () => {
    const deltas: string[] = [];
    let completed = false;
    let finalText = "";

    await dispatchCodexAppServerNotification(
      "item/agentMessage/delta",
      { turn: { id: "turn-1" }, delta: "Hi" },
      dispatchContext,
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => {
          completed = true;
        },
        onAgentMessageDelta: (delta) => deltas.push(delta),
        onAgentMessageCompleted: (text) => {
          finalText = text;
        },
      },
    );

    expect(deltas).toEqual(["Hi"]);

    await dispatchCodexAppServerNotification(
      "turn/completed",
      { turn: { id: "turn-1" } },
      dispatchContext,
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => {
          completed = true;
        },
        onAgentMessageDelta: () => undefined,
        onAgentMessageCompleted: () => undefined,
      },
    );

    await dispatchCodexAppServerNotification(
      "item/completed",
      { item: { type: "agentMessage", text: "Hi there" } },
      {
        ...dispatchContext,
        activeTurn: {
          ...activeTurn,
          turnCompletedPending: true,
          graceItemAcceptOpen: true,
          completionGraceToken: 1,
        },
        openCompletionGraceToken: 1,
      },
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => undefined,
        onAgentMessageDelta: () => undefined,
        onAgentMessageCompleted: (text) => {
          finalText = text;
        },
      },
    );

    expect(finalText).toBe("Hi there");
    expect(completed).toBe(true);
  });

  it("hydrates turn/completed summaries from turn payload agentMessage content and failure info", async () => {
    const summaries: Array<{ assistantText?: string; status?: string; errorMessage?: string }> = [];

    await dispatchCodexAppServerNotification(
      "turn/completed",
      {
        turn: {
          id: "turn-1",
          status: "failed",
          items: [{ type: "agentMessage", content: "Final from turn payload" }],
          error: { message: "Connection refused" },
        },
      },
      dispatchContext,
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: (summary) => {
          summaries.push(summary);
        },
        onAgentMessageDelta: () => undefined,
        onAgentMessageCompleted: () => undefined,
      },
    );

    expect(summaries).toEqual([
      {
        assistantText: "Final from turn payload",
        status: "failed",
        errorMessage: "Connection refused",
      },
    ]);
  });

  it("drops stale turnless deltas", async () => {
    const deltas: string[] = [];

    await dispatchCodexAppServerNotification(
      "item/agentMessage/delta",
      { delta: "stale" },
      dispatchContext,
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => undefined,
        onAgentMessageDelta: (delta) => deltas.push(delta),
        onAgentMessageCompleted: () => undefined,
      },
    );

    expect(deltas).toEqual([]);
  });

  it("routes detail notifications through onStreamDetail and rejects turnless detail events", async () => {
    const detailMethods: string[] = [];

    await dispatchCodexAppServerNotification(
      "item/started",
      {
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
      dispatchContext,
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => undefined,
        onAgentMessageDelta: () => undefined,
        onAgentMessageCompleted: () => undefined,
        onStreamDetail: (method) => {
          detailMethods.push(method);
        },
      },
    );

    expect(detailMethods).toEqual(["item/started"]);

    detailMethods.length = 0;
    await dispatchCodexAppServerNotification(
      "item/commandExecution/outputDelta",
      { itemId: "cmd-1", delta: "orphan" },
      dispatchContext,
      {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => undefined,
        onAgentMessageDelta: () => undefined,
        onAgentMessageCompleted: () => undefined,
        onStreamDetail: (method) => {
          detailMethods.push(method);
        },
      },
    );

    expect(detailMethods).toEqual([]);
  });
});
