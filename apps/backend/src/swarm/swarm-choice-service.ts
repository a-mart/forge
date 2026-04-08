import { randomUUID } from "node:crypto";
import type { ChoiceRequestEvent } from "@forge/protocol";
import type { AgentDescriptor, ChoiceAnswer, ChoiceQuestion, ChoiceRequestStatus } from "./types.js";

interface PendingChoiceRequest {
  choiceId: string;
  agentId: string;
  sessionAgentId: string;
  questions: ChoiceQuestion[];
  resolve: (answers: ChoiceAnswer[]) => void;
  reject: (reason: Error) => void;
  createdAt: string;
}

export class ChoiceRequestCancelledError extends Error {
  constructor(public readonly reason: "cancelled" | "expired") {
    super(`Choice request ${reason}`);
    this.name = "ChoiceRequestCancelledError";
  }
}

export interface SwarmChoiceServiceOptions {
  now: () => string;
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  emitChoiceRequest: (event: ChoiceRequestEvent) => void;
  emitAgentsSnapshot: () => void;
}

export class SwarmChoiceService {
  private readonly pendingChoiceRequests = new Map<string, PendingChoiceRequest>();

  constructor(private readonly options: SwarmChoiceServiceOptions) {}

  async requestUserChoice(agentId: string, questions: ChoiceQuestion[]): Promise<ChoiceAnswer[]> {
    const descriptor = this.options.getDescriptor(agentId);
    if (!descriptor) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const sessionAgentId = descriptor.role === "manager"
      ? agentId
      : descriptor.managerId;

    const choiceId = randomUUID().slice(0, 12);

    this.options.emitChoiceRequest({
      type: "choice_request",
      agentId,
      choiceId,
      questions,
      status: "pending",
      timestamp: this.options.now(),
    });

    return new Promise<ChoiceAnswer[]>((resolve, reject) => {
      this.pendingChoiceRequests.set(choiceId, {
        choiceId,
        agentId,
        sessionAgentId,
        questions,
        resolve,
        reject,
        createdAt: this.options.now(),
      });
      this.options.emitAgentsSnapshot();
    });
  }

  resolveChoiceRequest(choiceId: string, answers: ChoiceAnswer[]): void {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return;
    }

    this.pendingChoiceRequests.delete(choiceId);

    this.options.emitChoiceRequest({
      type: "choice_request",
      agentId: pending.agentId,
      choiceId,
      questions: pending.questions,
      status: "answered",
      answers,
      timestamp: this.options.now(),
    });

    pending.resolve(answers);
    this.options.emitAgentsSnapshot();
  }

  cancelChoiceRequest(choiceId: string, reason: Extract<ChoiceRequestStatus, "cancelled" | "expired">): void {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return;
    }

    this.pendingChoiceRequests.delete(choiceId);

    this.options.emitChoiceRequest({
      type: "choice_request",
      agentId: pending.agentId,
      choiceId,
      questions: pending.questions,
      status: reason,
      timestamp: this.options.now(),
    });

    pending.reject(new ChoiceRequestCancelledError(reason));
    this.options.emitAgentsSnapshot();
  }

  cancelAllPendingChoicesForAgent(agentId: string): void {
    for (const [choiceId, pending] of Array.from(this.pendingChoiceRequests.entries())) {
      if (pending.agentId === agentId || pending.sessionAgentId === agentId) {
        this.cancelChoiceRequest(choiceId, "cancelled");
      }
    }
  }

  hasPendingChoicesForSession(sessionAgentId: string): boolean {
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) {
        return true;
      }
    }
    return false;
  }

  getPendingChoiceIdsForSession(sessionAgentId: string): string[] {
    const ids: string[] = [];
    for (const pending of this.pendingChoiceRequests.values()) {
      if (pending.sessionAgentId === sessionAgentId) {
        ids.push(pending.choiceId);
      }
    }
    return ids;
  }

  getPendingChoiceOwner(choiceId: string): { agentId: string; sessionAgentId: string } | undefined {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return undefined;
    }

    return {
      agentId: pending.agentId,
      sessionAgentId: pending.sessionAgentId,
    };
  }

  getPendingChoice(choiceId: string): {
    agentId: string;
    sessionAgentId: string;
    questions: ChoiceQuestion[];
  } | undefined {
    const pending = this.pendingChoiceRequests.get(choiceId);
    if (!pending) {
      return undefined;
    }

    return {
      agentId: pending.agentId,
      sessionAgentId: pending.sessionAgentId,
      questions: pending.questions,
    };
  }
}
