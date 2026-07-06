import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MessageRouteDecision, MessageRouteReasonCode, MessageRouteTargetKind } from "../message-router.js";

export const MESSAGE_ROUTING_RECEIPTS_FILE = "receipts.jsonl";
export const MESSAGE_ROUTING_RECEIPTS_ROTATED_FILE = "receipts.jsonl.1";
export const MESSAGE_ROUTING_RECEIPTS_MAX_BYTES = 5 * 1024 * 1024;

export interface MessageRoutingReceiptRecord {
  type: "message_routing";
  timestamp: string;
  turnId?: string;
  agentId: string;
  decision: "render" | "route" | "drop";
  reasonCode: MessageRouteReasonCode;
  channel?: "web" | "telegram" | "cli" | "collab";
  targetKind: MessageRouteTargetKind;
  sourceWorkerId?: string;
}

export interface MessageRoutingReceiptInput {
  sessionFile: string;
  record: MessageRoutingReceiptRecord;
}

export function appendMessageRoutingReceipt(input: MessageRoutingReceiptInput): void {
  const receiptsPath = getMessageRoutingReceiptsPath(input.sessionFile);
  rotateMessageRoutingReceiptsIfNeeded(receiptsPath);
  appendFileSync(receiptsPath, `${JSON.stringify(input.record)}\n`, "utf8");
}

export function buildMessageRoutingReceipt(input: {
  agentId: string;
  timestamp: string;
  decision: MessageRouteDecision;
  turnId?: string;
  sourceWorkerId?: string;
}): MessageRoutingReceiptRecord {
  return {
    type: "message_routing",
    timestamp: input.timestamp,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    agentId: input.agentId,
    decision: input.decision.decision,
    reasonCode: input.decision.reasonCode,
    ...(input.decision.channel ? { channel: input.decision.channel } : {}),
    targetKind: input.decision.targetKind,
    ...(input.sourceWorkerId ? { sourceWorkerId: input.sourceWorkerId } : {}),
  };
}

export function getMessageRoutingReceiptsPath(sessionFile: string): string {
  return join(dirname(sessionFile), MESSAGE_ROUTING_RECEIPTS_FILE);
}

function rotateMessageRoutingReceiptsIfNeeded(receiptsPath: string): void {
  if (!existsSync(receiptsPath)) {
    return;
  }

  const stat = statSync(receiptsPath);
  if (stat.size < MESSAGE_ROUTING_RECEIPTS_MAX_BYTES) {
    return;
  }

  const rotatedPath = join(dirname(receiptsPath), MESSAGE_ROUTING_RECEIPTS_ROTATED_FILE);
  if (existsSync(rotatedPath)) {
    rmSync(rotatedPath);
  }
  renameSync(receiptsPath, rotatedPath);
}
