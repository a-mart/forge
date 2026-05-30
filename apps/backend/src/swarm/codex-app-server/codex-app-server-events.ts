import type { CodexSidecarActiveTurn } from "./types.js";
import { parseTurnIdFromNotificationParams } from "./codex-sidecar-ids.js";

export interface CodexNotificationDispatchContext {
  sidecarAgentId: string;
  managerAgentId: string;
  activeTurn?: CodexSidecarActiveTurn;
  openCompletionGraceToken: number;
  turnlessItemCompletedBurned: boolean;
}

export interface CodexNotificationDispatchCallbacks {
  onTurnStarted(turnId: string): void;
  onTurnCompleted(): void;
  onAgentMessageDelta(delta: string): void;
  onAgentMessageCompleted(text: string): void;
  onProcessExit?(error: Error): void;
}

export type CodexTurnlessItemNotificationMethod = "item/agentMessage/delta" | "item/completed";

function parseAgentMessageText(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const item = (params as { item?: { text?: unknown; content?: unknown } }).item;
  if (!item || typeof item !== "object") {
    return undefined;
  }

  if (typeof item.text === "string") {
    return item.text;
  }

  if (typeof item.content === "string") {
    return item.content;
  }

  return undefined;
}

function parseAgentMessageDelta(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }

  const delta = (params as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : "";
}

export function shouldIgnoreCodexNotification(
  activeTurn: CodexSidecarActiveTurn | undefined,
  notificationTurnId: string | undefined,
): boolean {
  if (!activeTurn) {
    return true;
  }

  if (activeTurn.suppressed) {
    return true;
  }

  if (notificationTurnId && activeTurn.turnId !== notificationTurnId) {
    return true;
  }

  return false;
}

export function shouldAcceptTurnlessItemNotification(
  activeTurn: CodexSidecarActiveTurn | undefined,
  openCompletionGraceToken: number,
  turnlessItemCompletedBurned: boolean,
  method: CodexTurnlessItemNotificationMethod,
): boolean {
  if (!activeTurn || activeTurn.suppressed || turnlessItemCompletedBurned) {
    return false;
  }

  if (method === "item/agentMessage/delta") {
    return false;
  }

  return (
    activeTurn.turnCompletedPending === true &&
    activeTurn.graceItemAcceptOpen === true &&
    activeTurn.completionGraceToken !== undefined &&
    activeTurn.completionGraceToken === openCompletionGraceToken &&
    method === "item/completed"
  );
}

export async function dispatchCodexAppServerNotification(
  method: string,
  params: unknown,
  context: CodexNotificationDispatchContext,
  callbacks: CodexNotificationDispatchCallbacks,
): Promise<void> {
  const notificationTurnId = parseTurnIdFromNotificationParams(params);
  const activeTurn = context.activeTurn;

  switch (method) {
    case "turn/started": {
      const turnId = notificationTurnId ?? activeTurn?.turnId;
      if (!turnId || !activeTurn || activeTurn.suppressed) {
        return;
      }

      if (
        notificationTurnId &&
        activeTurn.turnId &&
        activeTurn.turnId !== notificationTurnId
      ) {
        return;
      }

      callbacks.onTurnStarted(turnId);
      return;
    }

    case "turn/completed": {
      if (shouldIgnoreCodexNotification(activeTurn, notificationTurnId)) {
        return;
      }

      callbacks.onTurnCompleted();
      return;
    }

    case "item/agentMessage/delta": {
      if (notificationTurnId) {
        if (shouldIgnoreCodexNotification(activeTurn, notificationTurnId)) {
          return;
        }
      } else if (
        !shouldAcceptTurnlessItemNotification(
          activeTurn,
          context.openCompletionGraceToken,
          context.turnlessItemCompletedBurned,
          method,
        )
      ) {
        return;
      }

      const delta = parseAgentMessageDelta(params);
      if (delta) {
        callbacks.onAgentMessageDelta(delta);
      }
      break;
    }

    case "item/completed": {
      if (notificationTurnId) {
        if (shouldIgnoreCodexNotification(activeTurn, notificationTurnId)) {
          return;
        }
      } else if (
        !shouldAcceptTurnlessItemNotification(
          activeTurn,
          context.openCompletionGraceToken,
          context.turnlessItemCompletedBurned,
          method,
        )
      ) {
        return;
      }

      const item = (params as { item?: { type?: unknown } } | undefined)?.item;
      if (item?.type === "agentMessage") {
        const text = parseAgentMessageText(params);
        if (text) {
          callbacks.onAgentMessageCompleted(text);
        }
      }
      break;
    }

    default:
      break;
  }
}
