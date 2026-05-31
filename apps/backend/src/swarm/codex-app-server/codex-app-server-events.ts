import {
  extractStableItemId,
  isCodexStreamDetailNotificationMethod,
  shouldAcceptCodexDetailNotification,
} from "./codex-app-server-event-normalizer.js";
import type { CodexSidecarActiveTurn } from "./types.js";
import { parseTurnIdFromNotificationParams } from "./codex-sidecar-ids.js";

export interface CodexNotificationDispatchContext {
  sidecarAgentId: string;
  managerAgentId: string;
  activeTurn?: CodexSidecarActiveTurn;
  openCompletionGraceToken: number;
}

export interface CodexTurnCompletedSummary {
  assistantText?: string;
  status?: "completed" | "interrupted" | "failed" | "inProgress";
  errorMessage?: string;
}

export interface CodexNotificationDispatchCallbacks {
  onTurnStarted(turnId: string): void | Promise<void>;
  onTurnCompleted(summary: CodexTurnCompletedSummary): void | Promise<void>;
  onAgentMessageDelta(delta: string): void | Promise<void>;
  onAgentMessageCompleted(text: string, context: { turnless: boolean }): void | Promise<void>;
  onStreamDetail?(method: string, params: unknown): void | Promise<void>;
  onProcessExit?(error: Error): void | Promise<void>;
}

export type CodexTurnlessItemNotificationMethod = "item/agentMessage/delta" | "item/completed";

function parseAgentMessageTextFromItem(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const candidate = item as { type?: unknown; text?: unknown; content?: unknown };
  if (candidate.type !== undefined && candidate.type !== "agentMessage") {
    return undefined;
  }

  if (typeof candidate.text === "string") {
    return candidate.text;
  }

  if (typeof candidate.content === "string") {
    return candidate.content;
  }

  return undefined;
}

function parseAgentMessageText(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  return parseAgentMessageTextFromItem((params as { item?: unknown }).item);
}

function parseAgentMessageDelta(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }

  const delta = (params as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : "";
}

function parseTurnCompletedSummary(params: unknown): CodexTurnCompletedSummary {
  if (!params || typeof params !== "object") {
    return {};
  }

  const turn = (params as {
    turn?: {
      status?: unknown;
      items?: unknown;
      error?: { message?: unknown } | null;
    };
  }).turn;
  if (!turn || typeof turn !== "object") {
    return {};
  }

  const status =
    turn.status === "completed" ||
    turn.status === "interrupted" ||
    turn.status === "failed" ||
    turn.status === "inProgress"
      ? turn.status
      : undefined;

  let assistantText: string | undefined;
  if (Array.isArray(turn.items)) {
    for (const item of turn.items) {
      const parsed = parseAgentMessageTextFromItem(item);
      if (!parsed) {
        continue;
      }
      const trimmed = parsed.trim();
      if (trimmed) {
        assistantText = trimmed;
      }
    }
  }

  const errorMessage =
    turn.error && typeof turn.error === "object" && typeof turn.error.message === "string"
      ? turn.error.message.trim() || undefined
      : undefined;

  return {
    assistantText,
    status,
    errorMessage,
  };
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
  method: CodexTurnlessItemNotificationMethod,
): boolean {
  if (!activeTurn || activeTurn.suppressed) {
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

      await callbacks.onTurnStarted(turnId);
      return;
    }

    case "turn/completed": {
      if (shouldIgnoreCodexNotification(activeTurn, notificationTurnId)) {
        return;
      }

      await callbacks.onTurnCompleted(parseTurnCompletedSummary(params));
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
          method,
        )
      ) {
        return;
      }

      const delta = parseAgentMessageDelta(params);
      if (delta) {
        await callbacks.onAgentMessageDelta(delta);
      }
      break;
    }

    case "item/completed": {
      const item = (params as { item?: { type?: unknown } } | undefined)?.item;
      const isAgentMessage = item?.type === "agentMessage";

      if (isAgentMessage) {
        if (notificationTurnId) {
          if (shouldIgnoreCodexNotification(activeTurn, notificationTurnId)) {
            return;
          }
        } else if (
          !shouldAcceptTurnlessItemNotification(
            activeTurn,
            context.openCompletionGraceToken,
            method,
          )
        ) {
          return;
        }

        const text = parseAgentMessageText(params);
        if (text) {
          await callbacks.onAgentMessageCompleted(text, { turnless: !notificationTurnId });
        }
        break;
      }

      const itemId = extractStableItemId(params, item);
      if (shouldAcceptCodexDetailNotification(activeTurn, notificationTurnId, itemId)) {
        await callbacks.onStreamDetail?.(method, params);
      }
      break;
    }

    default: {
      if (isCodexStreamDetailNotificationMethod(method)) {
        const itemId = extractStableItemId(params);
        if (
          shouldAcceptCodexDetailNotification(activeTurn, notificationTurnId, itemId)
        ) {
          await callbacks.onStreamDetail?.(method, params);
        }
      }
      break;
    }
  }
}
