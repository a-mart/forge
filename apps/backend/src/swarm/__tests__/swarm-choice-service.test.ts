import type { ChoiceRequestEvent } from "@forge/protocol";
import { describe, expect, it } from "vitest";
import {
  ChoiceRequestCancelledError,
  SwarmChoiceService,
  type SwarmChoiceServiceOptions,
} from "../swarm-choice-service.js";
import type { AgentDescriptor } from "../types.js";

function createDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  const now = new Date("2026-04-13T00:00:00.000Z").toISOString();
  return {
    agentId: "manager-1",
    displayName: "Test Manager",
    role: "manager",
    managerId: "manager-1",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp/test",
    model: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      thinkingLevel: "medium",
    },
    sessionFile: "/tmp/test/session.jsonl",
    ...overrides,
  };
}

function createChoiceService() {
  const descriptors = new Map<string, AgentDescriptor>([
    ["manager-1", createDescriptor()],
    [
      "worker-1",
      createDescriptor({
        agentId: "worker-1",
        displayName: "Worker 1",
        role: "worker",
        managerId: "manager-1",
      }),
    ],
    [
      "manager-2",
      createDescriptor({
        agentId: "manager-2",
        displayName: "Other Manager",
        managerId: "manager-2",
      }),
    ],
  ]);

  const events: ChoiceRequestEvent[] = [];
  const state = { snapshotCount: 0, tick: 0 };

  const options: SwarmChoiceServiceOptions = {
    now: () => new Date(Date.UTC(2026, 3, 13, 0, 0, state.tick++)).toISOString(),
    getDescriptor: (agentId) => descriptors.get(agentId),
    emitChoiceRequest: (event) => {
      events.push(event);
    },
    emitAgentsSnapshot: () => {
      state.snapshotCount += 1;
    },
  };

  return {
    service: new SwarmChoiceService(options),
    descriptors,
    events,
    state,
  };
}

describe("SwarmChoiceService", () => {
  it("round-trips requestUserChoice through resolveChoiceRequest", async () => {
    const { service, events, state } = createChoiceService();
    const questions = [
      {
        id: "q1",
        question: "Choose one",
        options: [{ id: "opt-a", label: "Option A" }],
      },
    ];

    const pending = service.requestUserChoice("manager-1", questions);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "choice_request",
      agentId: "manager-1",
      questions,
      status: "pending",
    });

    const choiceId = events[0]?.choiceId;
    expect(choiceId).toHaveLength(12);
    expect(service.hasPendingChoicesForSession("manager-1")).toBe(true);
    expect(service.getPendingChoiceIdsForSession("manager-1")).toEqual([choiceId]);
    expect(service.getPendingChoice(choiceId ?? "")).toEqual({
      agentId: "manager-1",
      sessionAgentId: "manager-1",
      questions,
    });

    const answers = [
      {
        questionId: "q1",
        selectedOptionIds: ["opt-a"],
        text: "extra context",
      },
    ];

    service.resolveChoiceRequest(choiceId ?? "", answers);

    await expect(pending).resolves.toEqual(answers);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "choice_request",
      agentId: "manager-1",
      choiceId,
      questions,
      status: "answered",
      answers,
    });
    expect(service.hasPendingChoicesForSession("manager-1")).toBe(false);
    expect(service.getPendingChoice(choiceId ?? "")).toBeUndefined();
    expect(state.snapshotCount).toBe(2);
  });

  it("resolves multi-select answers for worker-owned choice requests", async () => {
    const { service, events } = createChoiceService();
    const questions = [
      {
        id: "q1",
        question: "Choose two or three",
        multiSelect: true,
        minSelections: 2,
        maxSelections: 3,
        options: [
          { id: "opt-a", label: "Option A" },
          { id: "opt-b", label: "Option B" },
          { id: "opt-c", label: "Option C" },
        ],
      },
    ];

    const pending = service.requestUserChoice("worker-1", questions);
    const choiceId = events[0]?.choiceId ?? "";

    expect(service.getPendingChoiceOwner(choiceId)).toEqual({
      agentId: "worker-1",
      sessionAgentId: "manager-1",
    });

    const answers = [
      {
        questionId: "q1",
        selectedOptionIds: ["opt-a", "opt-c"],
      },
    ];

    service.resolveChoiceRequest(choiceId, answers);

    await expect(pending).resolves.toEqual(answers);
    expect(events[1]).toMatchObject({
      status: "answered",
      answers: [
        {
          questionId: "q1",
          selectedOptionIds: ["opt-a", "opt-c"],
        },
      ],
    });
  });

  it("rejects pending choices with ChoiceRequestCancelledError on cancel", async () => {
    const { service, events } = createChoiceService();
    const pending = service.requestUserChoice("manager-1", [{ id: "q1", question: "Continue?" }]);
    const choiceId = events[0]?.choiceId ?? "";

    const rejection = expect(pending).rejects.toBeInstanceOf(ChoiceRequestCancelledError);
    service.cancelChoiceRequest(choiceId, "cancelled");
    await rejection;
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });

    expect(events[1]).toMatchObject({
      type: "choice_request",
      agentId: "manager-1",
      choiceId,
      status: "cancelled",
    });
    expect(service.getPendingChoiceOwner(choiceId)).toBeUndefined();
  });

  it("cancelAllPendingChoicesForAgent cancels manager and worker requests for the same session", async () => {
    const { service, events } = createChoiceService();

    const managerPending = service.requestUserChoice("manager-1", [{ id: "m1", question: "Manager choice?" }]);
    const workerPending = service.requestUserChoice("worker-1", [{ id: "w1", question: "Worker choice?" }]);
    const otherPending = service.requestUserChoice("manager-2", [{ id: "m2", question: "Other choice?" }]);

    const managerChoiceId = events[0]?.choiceId ?? "";
    const workerChoiceId = events[1]?.choiceId ?? "";
    const otherChoiceId = events[2]?.choiceId ?? "";

    const managerRejection = expect(managerPending).rejects.toMatchObject({ reason: "cancelled" });
    const workerRejection = expect(workerPending).rejects.toMatchObject({ reason: "cancelled" });

    service.cancelAllPendingChoicesForAgent("manager-1");

    await Promise.all([managerRejection, workerRejection]);

    expect(service.getPendingChoice(managerChoiceId)).toBeUndefined();
    expect(service.getPendingChoice(workerChoiceId)).toBeUndefined();
    expect(service.hasPendingChoicesForSession("manager-1")).toBe(false);
    expect(service.hasPendingChoicesForSession("manager-2")).toBe(true);
    expect(service.getPendingChoice(otherChoiceId)).toEqual({
      agentId: "manager-2",
      sessionAgentId: "manager-2",
      questions: [{ id: "m2", question: "Other choice?" }],
    });

    service.resolveChoiceRequest(otherChoiceId, []);
    await expect(otherPending).resolves.toEqual([]);

    expect(events.slice(3)).toEqual([
      expect.objectContaining({ choiceId: managerChoiceId, status: "cancelled" }),
      expect.objectContaining({ choiceId: workerChoiceId, status: "cancelled" }),
      expect.objectContaining({ choiceId: otherChoiceId, status: "answered", answers: [] }),
    ]);
  });
});
