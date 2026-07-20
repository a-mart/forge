import { describe, expect, it, vi } from "vitest";
import { createWorkerDescriptor } from "../../test-support/index.js";
import {
  WorkerResultCoordinator,
  buildWorkerResult,
} from "../worker-result-coordinator.js";
import type {
  AgentDescriptor,
  ConversationEntryEvent,
  ConversationMessageEvent,
} from "../types.js";

function message(
  text: string,
  overrides: Partial<ConversationMessageEvent> = {},
): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "worker-1",
    role: "assistant",
    source: "runtime",
    text,
    timestamp: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

function assignedWorker(): AgentDescriptor & { role: "worker" } {
  return {
    ...createWorkerDescriptor("/tmp/project", "manager-1", {
      agentId: "worker-1",
      status: "idle",
    }),
    workerParentContext: {
      schemaVersion: 1,
      assignmentId: "assignment-1",
      managerId: "manager-1",
      assignedAt: "2026-07-16T11:59:00.000Z",
      outputTarget: {
        kind: "session_transcript",
        channel: "web",
      },
      rootTurnId: "user-turn-1",
    },
  };
}

describe("WorkerResultCoordinator", () => {
  it("delivers the latest worker final once against the persisted assignment", async () => {
    const worker = assignedWorker();
    const deliverWorkerResult = vi.fn(async () => ({}));
    const coordinator = new WorkerResultCoordinator({
      getConversationHistory: () => [
        message("Earlier progress."),
        message("Validated implementation complete.", {
          attachments: [{
            type: "file",
            path: "/tmp/result.txt",
            name: "result.txt",
            mimeType: "text/plain",
          }],
        }),
      ],
      deliverWorkerResult,
      logDebug: vi.fn(),
    });

    await expect(coordinator.deliverCompletedWorker(worker)).resolves.toBe("sent");

    expect(deliverWorkerResult).toHaveBeenCalledTimes(1);
    expect(deliverWorkerResult).toHaveBeenCalledWith(
      worker.agentId,
      [
        "status: done",
        "summary:",
        "Validated implementation complete.",
        "",
        "attachments: 1 generated attachment",
      ].join("\n"),
      "assignment-1",
    );
  });

  it("does not read or log recovered retired-channel result content", async () => {
    const worker = assignedWorker();
    worker.workerParentContext!.outputTarget = {
      kind: "external_channel",
      sourceContext: { channel: "telegram", channelId: "retired-sensitive-chat" },
    };
    const getConversationHistory = vi.fn(() => [message("retired-sensitive-result-content")]);
    const deliverWorkerResult = vi.fn(async () => ({}));
    const logDebug = vi.fn();
    const coordinator = new WorkerResultCoordinator({
      getConversationHistory,
      deliverWorkerResult,
      logDebug,
    });

    await expect(coordinator.deliverCompletedWorker(worker)).resolves.toBe("sent");

    expect(getConversationHistory).not.toHaveBeenCalled();
    expect(deliverWorkerResult).toHaveBeenCalledWith("worker-1", "", "assignment-1");
    expect(logDebug).not.toHaveBeenCalled();
  });

  it("marks terminal system errors blocked", () => {
    expect(buildWorkerResult("worker-1", [
      message("Worker failed after a terminated process.", { role: "system" }),
    ])).toBe([
      "status: blocked",
      "summary:",
      "Worker failed after a terminated process.",
    ].join("\n"));
  });

  it("marks projected runtime errors blocked", () => {
    expect(buildWorkerResult("worker-1", [
      message("⚠️ Agent error: provider unavailable. Message may need to be resent.", {
        role: "system",
      }),
    ])).toContain("status: blocked");
  });

  it("ignores legacy worker-report rows when selecting the final", () => {
    const history: ConversationEntryEvent[] = [
      message("The actual worker conclusion."),
      message("WORKER REPORT: legacy wrapper", {
        role: "system",
        source: "worker_report",
      }),
    ];

    expect(buildWorkerResult("worker-1", history)).toContain("The actual worker conclusion.");
    expect(buildWorkerResult("worker-1", history)).not.toContain("legacy wrapper");
  });

  it("preserves an already structured worker result without nesting status fields", () => {
    expect(buildWorkerResult("worker-1", [
      message("status: partial\nsummary: Core work passed; one optional check remains."),
    ])).toBe("status: partial\nsummary: Core work passed; one optional check remains.");
  });

  it("ignores trailing whitespace-only messages", () => {
    expect(buildWorkerResult("worker-1", [
      message("The actual worker conclusion."),
      message("  \n  ", { role: "system" }),
    ])).toContain("The actual worker conclusion.");
  });

  it("ignores benign system summaries when no assistant final exists", () => {
    const result = buildWorkerResult("worker-1", [
      message("Completed successfully after handling an expected error case.", { role: "system" }),
    ]);

    expect(result).toContain("status: blocked");
    expect(result).toContain("settled without returning a final result");
    expect(result).not.toContain("Completed successfully");
  });

  it("does not replay an assistant final from before the current assignment", async () => {
    const worker = assignedWorker();
    const deliverWorkerResult = vi.fn(async () => ({}));
    const coordinator = new WorkerResultCoordinator({
      getConversationHistory: () => [
        message("Stale result from the previous run.", {
          timestamp: "2026-07-16T11:58:59.000Z",
        }),
      ],
      deliverWorkerResult,
      logDebug: vi.fn(),
    });

    await coordinator.deliverCompletedWorker(worker);

    expect(deliverWorkerResult).toHaveBeenCalledWith(
      worker.agentId,
      [
        "status: blocked",
        "summary: Worker worker-1 settled without returning a final result.",
        "follow-up: Check the worker or retry the assignment.",
      ].join("\n"),
      "assignment-1",
    );
  });

  it("skips workers without an assigned parent instead of guessing a route", async () => {
    const worker = createWorkerDescriptor("/tmp/project", "manager-1", {
      agentId: "worker-1",
      status: "idle",
    }) as AgentDescriptor & { role: "worker" };
    const deliverWorkerResult = vi.fn();
    const coordinator = new WorkerResultCoordinator({
      getConversationHistory: () => [message("Done")],
      deliverWorkerResult,
      logDebug: vi.fn(),
    });

    await expect(coordinator.deliverCompletedWorker(worker)).resolves.toBe("skipped");
    expect(deliverWorkerResult).not.toHaveBeenCalled();
  });

  it("keeps the parent context available when delivery fails so restart recovery can retry", async () => {
    const worker = assignedWorker();
    const coordinator = new WorkerResultCoordinator({
      getConversationHistory: () => [message("Done")],
      deliverWorkerResult: vi.fn(async () => {
        throw new Error("manager unavailable");
      }),
      logDebug: vi.fn(),
    });

    await expect(coordinator.deliverCompletedWorker(worker)).resolves.toBe("failed");
    expect(worker.workerParentContext?.assignmentId).toBe("assignment-1");
  });
});
