import { rename, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { appendJsonl } from "../utils/atomic-files.js";
import { isEnoentError } from "../utils/fs-errors.js";
import { getSessionTurnLedgerPath } from "./data-paths.js";
import type { AgentDescriptor } from "./types.js";

export const TURN_LEDGER_MAX_BYTES = 5 * 1024 * 1024;

export type TurnLedgerInboundKind = "user" | "worker_report" | "schedule" | "agent_message" | "project_agent" | "system";
export type TurnLedgerTerminalOutcome = "agent_end" | "idle" | "error" | "recycled" | "abandoned" | "reconciled";

export type TurnLedgerRecord =
  | {
      t: "turn_dispatched";
      turnId: string;
      agentId: string;
      role: AgentDescriptor["role"];
      inboundId?: string;
      kind: TurnLedgerInboundKind;
      /** Collaboration user id that initiated the turn, or "local" (Wave R). */
      initiatedBy?: string;
      at: string;
    }
  | { t: "delivery_pending"; turnId?: string; deliveryId: string; from: string; to: string; message?: string; at: string }
  | { t: "delivery_acked"; deliveryId: string; at: string }
  | { t: "turn_terminal"; turnId: string; outcome: TurnLedgerTerminalOutcome; at: string }
  | { t: "turn_stalled"; turnId: string; agentId: string; tier: 1 | 2 | 3; at: string }
  | { t: "recovery_receipt"; receipt: string; agentId?: string; turnId?: string; deliveryId?: string; at: string };

export interface TurnLedgerSessionTarget {
  dataDir: string;
  profileId: string;
  sessionAgentId: string;
}

export interface ReplayedTurnLedger {
  records: TurnLedgerRecord[];
  openTurns: Map<string, Extract<TurnLedgerRecord, { t: "turn_dispatched" }>>;
  terminalTurns: Map<string, Extract<TurnLedgerRecord, { t: "turn_terminal" }>>;
  pendingDeliveries: Map<string, Extract<TurnLedgerRecord, { t: "delivery_pending" }>>;
  ackedDeliveries: Set<string>;
}

export async function appendTurnLedgerRecord(target: TurnLedgerSessionTarget, record: TurnLedgerRecord): Promise<void> {
  const filePath = getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId);
  await rotateTurnLedgerIfNeeded(filePath);
  await appendJsonl(filePath, record);
}

export async function replayTurnLedger(target: TurnLedgerSessionTarget): Promise<ReplayedTurnLedger> {
  const filePath = getSessionTurnLedgerPath(target.dataDir, target.profileId, target.sessionAgentId);
  const records: TurnLedgerRecord[] = [];
  const openTurns = new Map<string, Extract<TurnLedgerRecord, { t: "turn_dispatched" }>>();
  const terminalTurns = new Map<string, Extract<TurnLedgerRecord, { t: "turn_terminal" }>>();
  const pendingDeliveries = new Map<string, Extract<TurnLedgerRecord, { t: "delivery_pending" }>>();
  const ackedDeliveries = new Set<string>();

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
  } catch (error) {
    if (isEnoentError(error)) {
      return { records, openTurns, terminalTurns, pendingDeliveries, ackedDeliveries };
    }
    throw error;
  }

  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isTurnLedgerRecord(parsed)) continue;
      records.push(parsed);
      switch (parsed.t) {
        case "turn_dispatched":
          openTurns.set(parsed.turnId, parsed);
          break;
        case "turn_terminal":
          terminalTurns.set(parsed.turnId, parsed);
          openTurns.delete(parsed.turnId);
          break;
        case "delivery_pending":
          pendingDeliveries.set(parsed.deliveryId, parsed);
          break;
        case "delivery_acked":
          ackedDeliveries.add(parsed.deliveryId);
          pendingDeliveries.delete(parsed.deliveryId);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  return { records, openTurns, terminalTurns, pendingDeliveries, ackedDeliveries };
}

async function rotateTurnLedgerIfNeeded(filePath: string): Promise<void> {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }
    throw error;
  }
  if (size < TURN_LEDGER_MAX_BYTES) {
    return;
  }
  try {
    // eslint-disable-next-line no-restricted-syntax -- file rotation (move), not a temp+rename content write
    await rename(filePath, `${filePath}.1`);
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }
}

function isTurnLedgerRecord(value: unknown): value is TurnLedgerRecord {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { t?: unknown; turnId?: unknown; agentId?: unknown; deliveryId?: unknown };
  switch (maybe.t) {
    case "turn_dispatched":
    case "turn_terminal":
    case "turn_stalled":
      return typeof maybe.turnId === "string" && maybe.turnId.length > 0;
    case "delivery_pending":
    case "delivery_acked":
      return typeof maybe.deliveryId === "string" && maybe.deliveryId.length > 0;
    case "recovery_receipt":
      return true;
    default:
      return false;
  }
}
