import { describe, expect, it, vi } from "vitest";
import type { ConversationProjector } from "../conversation-projector.js";
import { SessionActiveToolsState } from "../session-active-tools.js";
import { SwarmEventCoordinator } from "../swarm-event-coordinator.js";
import type { SwarmObservabilityCoordinator } from "../swarm-observability-coordinator.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

function manager(agentId = "manager-1"): AgentDescriptor {
  return {
    agentId,
    role: "manager",
    status: "idle",
    label: agentId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    model: { provider: "openai", modelId: "gpt-5" },
  } as AgentDescriptor;
}

function worker(agentId: string, managerId: string): AgentDescriptor {
  return {
    ...manager(agentId),
    role: "worker",
    managerId,
  } as AgentDescriptor;
}

function setup(initialDescriptors: AgentDescriptor[] = [manager()]) {
  const descriptors = new Map(initialDescriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const emitted: Array<{ name: string; event: unknown }> = [];
  const upsertDescriptor = vi.fn();
  const profile = { profileId: "profile-1", name: "Profile" } as ManagerProfile;
  const conversationProjector = {
    emitConversationMessage: vi.fn(),
    emitAgentMessage: vi.fn(),
    emitChoiceRequest: vi.fn(),
    emitModelCacheObservation: vi.fn(),
    emitConversationReset: vi.fn(),
  } as unknown as ConversationProjector;
  const observability = {
    recordUserVisibleMessage: vi.fn(),
  } as unknown as SwarmObservabilityCoordinator;
  const coordinator = new SwarmEventCoordinator({
    host: {
      emit: (name, event) => emitted.push({ name, event }),
      getDescriptor: (agentId) => descriptors.get(agentId),
      getRuntime: () => undefined,
      listManagerAgents: () => [manager()],
      listProfiles: () => [profile],
      upsertDescriptor,
    },
    conversationProjector,
    observability,
    sessionActiveTools: new SessionActiveToolsState(),
    now: () => "2026-07-13T00:00:05.000Z",
  });
  return { coordinator, emitted, upsertDescriptor, conversationProjector, observability };
}

describe("SwarmEventCoordinator", () => {
  it("coalesces agent snapshots and advances the version once", async () => {
    const { coordinator, emitted } = setup();

    coordinator.emitAgentsSnapshot();
    coordinator.emitAgentsSnapshot();
    await Promise.resolve();

    expect(emitted.filter(({ name }) => name === "agents_snapshot")).toHaveLength(1);
    expect(coordinator.getAgentsSnapshotVersion()).toBe(1);
  });

  it("attributes worker activity to the owning manager", () => {
    const owner = manager();
    const { coordinator, upsertDescriptor } = setup([owner, worker("worker-1", owner.agentId)]);

    coordinator.markSessionActivity("worker-1", "2026-07-13T00:00:04.000Z");

    expect(owner.updatedAt).toBe("2026-07-13T00:00:04.000Z");
    expect(upsertDescriptor).toHaveBeenCalledWith(owner);
  });

  it("projects visible messages and records observability through one boundary", () => {
    const { coordinator, conversationProjector, observability } = setup();
    const event = {
      type: "conversation_message",
      agentId: "manager-1",
      role: "assistant",
      content: "done",
      timestamp: "2026-07-13T00:00:04.000Z",
    } as Parameters<SwarmEventCoordinator["emitConversationMessage"]>[0];

    coordinator.emitConversationMessage(event);

    expect(conversationProjector.emitConversationMessage).toHaveBeenCalledWith(event, undefined);
    expect(observability.recordUserVisibleMessage).toHaveBeenCalledWith(event);
  });
});
