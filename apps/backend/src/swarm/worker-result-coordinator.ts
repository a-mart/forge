import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ConversationMessageEvent,
} from "./types.js";
import type { SessionPlanCoordinator } from "./planning/session-plan-coordinator.js";
import { previewForLog } from "./swarm-manager-utils.js";

const MAX_WORKER_RESULT_CHARS = 16_000;

export interface WorkerResultCoordinatorOptions {
  getConversationHistory(agentId: string): ConversationEntryEvent[];
  deliverWorkerResult(
    workerAgentId: string,
    resultText: string,
    expectedAssignmentId: string,
  ): Promise<unknown>;
  recordWorkGraphResult?(
    descriptor: AgentDescriptor & { role: "worker" },
    resultText: string,
  ): Promise<unknown>;
  logDebug(message: string, details?: unknown): void;
}

/** Converts one terminal worker run into one typed result for its owning manager. */
export class WorkerResultCoordinator {
  constructor(private readonly options: WorkerResultCoordinatorOptions) {}

  async deliverCompletedWorker(
    descriptor: AgentDescriptor & { role: "worker" },
  ): Promise<"sent" | "skipped" | "failed"> {
    const parentContext = descriptor.workerParentContext;
    if (!parentContext) {
      this.options.logDebug("worker_result:skip_unassigned", {
        workerAgentId: descriptor.agentId,
        managerId: descriptor.managerId,
      });
      return "skipped";
    }

    const recoveredRetiredTarget =
      parentContext.outputTarget.kind === "external_channel" &&
      parentContext.outputTarget.sourceContext.channel === "telegram";
    const resultText = recoveredRetiredTarget
      ? ""
      : buildWorkerResult(
          descriptor.agentId,
          this.options.getConversationHistory(descriptor.agentId),
          parentContext.assignedAt,
        );
    if (this.options.recordWorkGraphResult) {
      await this.options.recordWorkGraphResult(descriptor, resultText).catch((error) => {
        this.options.logDebug("worker_result:work_graph_error", {
          workerAgentId: descriptor.agentId,
          managerId: descriptor.managerId,
          assignmentId: parentContext.assignmentId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    try {
      await this.options.deliverWorkerResult(
        descriptor.agentId,
        resultText,
        parentContext.assignmentId,
      );
      if (!recoveredRetiredTarget) {
        this.options.logDebug("worker_result:sent", {
          workerAgentId: descriptor.agentId,
          managerId: descriptor.managerId,
          assignmentId: parentContext.assignmentId,
          textPreview: previewForLog(resultText),
        });
      }
      return "sent";
    } catch (error) {
      this.options.logDebug("worker_result:error", {
        workerAgentId: descriptor.agentId,
        managerId: descriptor.managerId,
        assignmentId: parentContext.assignmentId,
        message: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
  }
}

export function createWorkGraphResultRecorder(options: {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  getPlans(): Pick<SessionPlanCoordinator, "recordWorkGraphWorkerResult">;
}): NonNullable<WorkerResultCoordinatorOptions["recordWorkGraphResult"]> {
  return async (worker, resultText) => {
    const manager = options.descriptors.get(worker.managerId);
    if (
      !manager
      || manager.role !== "manager"
      || !manager.profileId
      || manager.sessionSurface === "collab"
    ) return;
    await options.getPlans().recordWorkGraphWorkerResult(
      manager as AgentDescriptor & { role: "manager"; profileId: string },
      worker.agentId,
      resultText,
    );
  };
}

export function buildWorkerResult(
  workerAgentId: string,
  history: ConversationEntryEvent[],
  assignedAt?: string,
): string {
  const finalMessage = findLatestWorkerFinal(history, assignedAt);
  if (!finalMessage) {
    return [
      "status: blocked",
      `summary: Worker ${workerAgentId} settled without returning a final result.`,
      "follow-up: Check the worker or retry the assignment.",
    ].join("\n");
  }

  const rawText = finalMessage.text.trim();
  const lines = /^status:\s*(?:done|partial|blocked)(?:\s|$)/i.test(rawText)
    ? [rawText]
    : [
        `status: ${looksLikeWorkerError(finalMessage) ? "blocked" : "done"}`,
        "summary:",
        rawText.length > 0
          ? rawText
          : `Worker ${workerAgentId} completed without a final text result.`,
      ];
  const attachmentCount = finalMessage.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    lines.push(
      "",
      `attachments: ${attachmentCount} generated attachment${attachmentCount === 1 ? "" : "s"}`,
    );
  }
  return truncateWorkerResult(lines.join("\n"));
}

function findLatestWorkerFinal(
  history: ConversationEntryEvent[],
  assignedAt?: string,
): ConversationMessageEvent | undefined {
  const assignedAtMs = assignedAt ? Date.parse(assignedAt) : undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (
      entry?.type === "conversation_message" &&
      (entry.role === "assistant" || (entry.role === "system" && looksLikeWorkerError(entry))) &&
      entry.source !== "worker_report" &&
      (entry.text.trim().length > 0 || (entry.attachments?.length ?? 0) > 0) &&
      (
        assignedAtMs === undefined ||
        Number.isNaN(assignedAtMs) ||
        Date.parse(entry.timestamp) >= assignedAtMs
      )
    ) {
      return entry;
    }
  }
  return undefined;
}

function looksLikeWorkerError(message: ConversationMessageEvent): boolean {
  return (
    message.role === "system" &&
    /^(?:⚠️\s*)?(?:worker\b.*\b(?:failed|blocked|terminated|timed out)\b|(?:agent|runtime|compaction|context guard|extension) error\b|error:)/i.test(
      message.text.trim(),
    )
  );
}

function truncateWorkerResult(text: string): string {
  if (text.length <= MAX_WORKER_RESULT_CHARS) {
    return text;
  }
  const marker = "\n\n[worker result truncated]";
  return `${text.slice(0, MAX_WORKER_RESULT_CHARS - marker.length).trimEnd()}${marker}`;
}
