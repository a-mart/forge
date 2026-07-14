import { randomUUID } from "node:crypto";
import type { RestartRecoverySnapshot } from "@forge/protocol";
import {
  appendTurnLedgerRecord,
  replayTurnLedger,
  type TurnLedgerSessionTarget,
} from "./turn-ledger.js";
import type {
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
} from "./types.js";

interface InternalSendOptions {
  origin: "internal";
  workerReportSourceAgentId?: string;
}

export interface RestartRecoveryCoordinatorOptions {
  descriptors: Map<string, AgentDescriptor>;
  getSessionTarget: (agentId: string) => TurnLedgerSessionTarget | null;
  sendMessage: (
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode,
    options: InternalSendOptions,
  ) => Promise<SendMessageReceipt>;
  now: () => string;
  onDecisionResolved?: () => void;
  logDebug: (message: string, details?: unknown) => void;
}

/** Owns boot-time turn-ledger reconciliation and one-shot restart recovery. */
export class RestartRecoveryCoordinator {
  private snapshot: RestartRecoverySnapshot | null = null;
  private resumeInProgress = false;

  constructor(private readonly options: RestartRecoveryCoordinatorOptions) {}

  async reconcileForBoot(): Promise<void> {
    const interruptedManagers = new Set<string>();
    const interruptedWorkers = new Set<string>();
    const undeliveredReports = new Map<
      string,
      { deliveryId: string; fromAgentId: string; toAgentId: string; turnId?: string }
    >();

    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "manager") continue;

      const target = this.options.getSessionTarget(descriptor.agentId);
      if (!target) continue;

      const replay = await replayTurnLedger(target).catch((error) => {
        this.options.logDebug("turn_ledger:boot_replay:error", {
          sessionAgentId: descriptor.agentId,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      if (!replay) continue;

      const dispatchedTurnIds = new Set(
        replay.records
          .filter((record) => record.t === "turn_dispatched")
          .map((record) => record.turnId),
      );
      const receiptKeys = new Set(
        replay.records
          .filter((record) => record.t === "recovery_receipt")
          .map(
            (record) =>
              `${record.receipt}:${record.turnId ?? ""}:${record.deliveryId ?? ""}`,
          ),
      );

      for (const terminal of replay.terminalTurns.values()) {
        if (dispatchedTurnIds.has(terminal.turnId)) continue;
        const key = `terminal_without_dispatch:${terminal.turnId}:`;
        if (!receiptKeys.has(key)) {
          await appendTurnLedgerRecord(target, {
            t: "recovery_receipt",
            receipt: "terminal_without_dispatch",
            turnId: terminal.turnId,
            at: this.options.now(),
          });
        }
      }

      for (const openTurn of replay.openTurns.values()) {
        const actor = this.options.descriptors.get(openTurn.agentId);
        if (actor?.status === "streaming") {
          (actor.role === "manager" ? interruptedManagers : interruptedWorkers).add(
            actor.agentId,
          );
          const key = `turn_interrupted:${openTurn.turnId}:`;
          if (!receiptKeys.has(key)) {
            await appendTurnLedgerRecord(target, {
              t: "recovery_receipt",
              receipt: "turn_interrupted",
              agentId: actor.agentId,
              turnId: openTurn.turnId,
              at: this.options.now(),
            });
          }
          continue;
        }

        await appendTurnLedgerRecord(target, {
          t: "turn_terminal",
          turnId: openTurn.turnId,
          outcome: "reconciled",
          at: this.options.now(),
        });
      }

      for (const pending of replay.pendingDeliveries.values()) {
        if (replay.ackedDeliveries.has(pending.deliveryId)) continue;
        undeliveredReports.set(pending.deliveryId, {
          deliveryId: pending.deliveryId,
          fromAgentId: pending.from,
          toAgentId: pending.to,
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
        });
      }
    }

    const snapshot: RestartRecoverySnapshot = {
      bootId: randomUUID(),
      createdAt: this.options.now(),
      interruptedManagers: [...interruptedManagers].sort(),
      interruptedWorkers: [...interruptedWorkers].sort(),
      undeliveredReports: [...undeliveredReports.values()].sort((left, right) =>
        left.deliveryId.localeCompare(right.deliveryId),
      ),
    };
    const hasRecovery =
      snapshot.interruptedManagers.length > 0 ||
      snapshot.interruptedWorkers.length > 0 ||
      snapshot.undeliveredReports.length > 0;
    this.snapshot = hasRecovery ? snapshot : null;
    if (hasRecovery) {
      this.options.logDebug("turn_ledger:boot_recovery_snapshot", snapshot);
    }
  }

  getSnapshot(): RestartRecoverySnapshot | null {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  isDecisionPending(): boolean {
    return this.resumeInProgress || Boolean(
      this.snapshot && !this.snapshot.resumedAt && !this.snapshot.dismissedAt,
    );
  }

  dismiss(): RestartRecoverySnapshot | null {
    if (!this.snapshot) return null;
    this.snapshot = { ...this.snapshot, dismissedAt: this.options.now() };
    this.options.onDecisionResolved?.();
    return this.getSnapshot();
  }

  async resume(): Promise<RestartRecoverySnapshot | null> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.resumedAt || snapshot.dismissedAt) {
      return this.getSnapshot();
    }
    this.resumeInProgress = true;
    this.snapshot = { ...snapshot, resumedAt: this.options.now() };
    try {
      for (const workerId of snapshot.interruptedWorkers) {
      const worker = this.options.descriptors.get(workerId);
      if (!worker || worker.role !== "worker") continue;
      await this.options
        .sendMessage(
          worker.managerId,
          worker.agentId,
          "The backend restarted while you were mid-turn. Continue from the last persisted state. If your last action was interrupted, the process died during your last action — consider whether repeating it is safe.",
          "auto",
          { origin: "internal" },
        )
        .catch((error) => this.logResumeError("worker", workerId, error));
      }

      for (const managerId of snapshot.interruptedManagers) {
      await this.options
        .sendMessage(
          managerId,
          managerId,
          "The backend restarted while you were mid-turn. Resume from the last persisted state and continue coordinating any interrupted workers.",
          "auto",
          { origin: "internal" },
        )
        .catch((error) => this.logResumeError("manager", managerId, error));
      }

      const pendingMessages = await this.resolvePendingReportMessages(snapshot);
      for (const report of snapshot.undeliveredReports) {
      const message = pendingMessages.get(report.deliveryId);
      if (!message) continue;
      await this.options
        .sendMessage(report.fromAgentId, report.toAgentId, message, "auto", {
          origin: "internal",
          workerReportSourceAgentId: report.fromAgentId,
        })
        .catch((error) => {
          this.options.logDebug("restart_recovery:report_redelivery:error", {
            deliveryId: report.deliveryId,
            fromAgentId: report.fromAgentId,
            toAgentId: report.toAgentId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }

      return this.getSnapshot();
    } finally {
      this.resumeInProgress = false;
      this.options.onDecisionResolved?.();
    }
  }

  private async resolvePendingReportMessages(
    snapshot: RestartRecoverySnapshot,
  ): Promise<Map<string, string>> {
    const wantedIds = new Set(
      snapshot.undeliveredReports.map((report) => report.deliveryId),
    );
    const messages = new Map<string, string>();
    if (wantedIds.size === 0) return messages;

    const sessionIds = new Set(
      snapshot.undeliveredReports.map((report) => report.toAgentId),
    );
    for (const sessionId of sessionIds) {
      const target = this.options.getSessionTarget(sessionId);
      if (!target) continue;
      const replay = await replayTurnLedger(target).catch(() => null);
      if (!replay) continue;
      for (const record of replay.records) {
        if (
          record.t === "delivery_pending" &&
          wantedIds.has(record.deliveryId) &&
          record.message
        ) {
          messages.set(record.deliveryId, record.message);
        }
      }
    }
    return messages;
  }

  private logResumeError(
    role: "worker" | "manager",
    agentId: string,
    error: unknown,
  ): void {
    this.options.logDebug(`restart_recovery:${role}_resume:error`, {
      [`${role}Id`]: agentId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function cloneSnapshot(snapshot: RestartRecoverySnapshot): RestartRecoverySnapshot {
  return {
    ...snapshot,
    interruptedManagers: [...snapshot.interruptedManagers],
    interruptedWorkers: [...snapshot.interruptedWorkers],
    undeliveredReports: snapshot.undeliveredReports.map((report) => ({ ...report })),
  };
}
