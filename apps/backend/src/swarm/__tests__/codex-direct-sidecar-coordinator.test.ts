import { describe, expect, it, vi } from "vitest";
import { createManagerDescriptor } from "../../test-support/fixtures.js";
import { CodexAppServerService } from "../codex-app-server/codex-app-server-service.js";
import {
  CodexDirectSidecarCoordinator,
  type CodexDirectSidecarCoordinatorHost,
  type CodexDirectSidecarManager,
} from "../codex-app-server/codex-direct-sidecar-coordinator.js";
import {
  CodexSidecarBusyError,
  type CodexSidecarHost,
} from "../codex-app-server/types.js";
import type { AgentDescriptor } from "../types.js";

describe("CodexDirectSidecarCoordinator", () => {
  it("routes a leading Builder-web mention through a persistent sidecar", async () => {
    const harness = new CoordinatorHarness();

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.manager,
      text: "@Codex   summarize the calendar  ",
      attachments: [],
      sourceContext: { channel: "web" },
    })).resolves.toBe(true);

    expect(harness.getOrCreateSidecarDescriptor).toHaveBeenCalledWith(harness.manager);
    expect(harness.sendTextTurn).toHaveBeenCalledWith(
      harness.sidecar.agentId,
      "summarize the calendar",
      {
        promptPreview: "summarize the calendar",
        parentRouting: {
          managerAgentId: harness.manager.agentId,
          emitParentRequestCard: true,
          sourceContext: { channel: "web" },
        },
      },
    );
    expect(harness.trustPrompts).toEqual([harness.manager.agentId]);
    expect(harness.sessionActivity).toEqual([
      `activity:${harness.manager.agentId}:2026-07-13T12:00:00.000Z`,
      `user:${harness.manager.agentId}:2026-07-13T12:00:00.000Z`,
    ]);
  });

  it("routes a direct selected sidecar send without emitting a parent request card", async () => {
    const harness = new CoordinatorHarness();

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.sidecar,
      text: "follow up without mention",
      attachments: [],
      sourceContext: { channel: "web" },
    })).resolves.toBe(true);

    expect(harness.getOrCreateSidecarDescriptor).not.toHaveBeenCalled();
    expect(harness.sendTextTurn).toHaveBeenCalledWith(
      harness.sidecar.agentId,
      "follow up without mention",
      expect.objectContaining({
        parentRouting: expect.objectContaining({ emitParentRequestCard: false }),
      }),
    );
    expect(harness.trustPrompts).toEqual([harness.manager.agentId]);
  });

  it("leaves ordinary and plugin-delegated messages on their existing paths", async () => {
    const harness = new CoordinatorHarness();
    const worker = createWorkerDescriptor("worker", harness.manager.agentId);

    for (const input of [
      { target: harness.manager, text: "ordinary manager message", channel: "web" as const },
      { target: harness.manager, text: "@Codex -fireflies list meetings", channel: "web" as const },
      { target: harness.manager, text: "@Codex direct but from CLI", channel: "cli" as const },
      { target: worker, text: "@Codex direct", channel: "web" as const },
    ]) {
      await expect(harness.coordinator.maybeRouteUserMessage({
        target: input.target,
        text: input.text,
        attachments: [],
        sourceContext: { channel: input.channel },
      })).resolves.toBe(false);
    }

    expect(harness.getOrCreateSidecarDescriptor).not.toHaveBeenCalled();
    expect(harness.sendTextTurn).not.toHaveBeenCalled();
  });

  it("validates direct-route surface, content, attachments, and parent ownership before sending", async () => {
    const harness = new CoordinatorHarness();

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.sidecar,
      text: "from cli",
      attachments: [],
      sourceContext: { channel: "cli" },
    })).rejects.toThrow(/Builder web sessions/);

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.sidecar,
      text: "with attachment",
      attachments: [{ type: "text", mimeType: "text/plain", data: "hello" }],
      sourceContext: { channel: "web" },
    })).rejects.toThrow(/text only/);

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.sidecar,
      text: "",
      attachments: [],
      sourceContext: { channel: "web" },
    })).rejects.toThrow(/must not be empty/);

    harness.descriptors.delete(harness.manager.agentId);
    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.sidecar,
      text: "orphaned",
      attachments: [],
      sourceContext: { channel: "web" },
    })).rejects.toThrow(/missing its parent manager/);

    expect(harness.sendTextTurn).not.toHaveBeenCalled();
  });

  it("validates leading mentions before sidecar creation", async () => {
    const harness = new CoordinatorHarness();

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.manager,
      text: "@Codex",
      attachments: [],
      sourceContext: { channel: "web" },
    })).rejects.toThrow(/Add a message after @Codex/);

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.manager,
      text: "@Codex hello",
      attachments: [{ type: "text", mimeType: "text/plain", data: "hello" }],
      sourceContext: { channel: "web" },
    })).rejects.toThrow(/text-only messages/);

    harness.manager.projectAgent = { handle: "Codex", whenToUse: "legacy collision" };
    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.manager,
      text: "@Codex hello",
      attachments: [],
      sourceContext: { channel: "web" },
    })).rejects.toThrow(/project agent handle "codex" is already in use/i);

    expect(harness.getOrCreateSidecarDescriptor).not.toHaveBeenCalled();
  });

  it("maps the service busy sentinel and records activity only after an accepted send", async () => {
    const harness = new CoordinatorHarness();
    harness.sendTextTurn.mockRejectedValueOnce(
      new CodexSidecarBusyError(harness.sidecar.agentId),
    );

    await expect(harness.coordinator.maybeRouteUserMessage({
      target: harness.manager,
      text: "@Codex second question",
      attachments: [],
      sourceContext: { channel: "web" },
    })).rejects.toThrow("Codex is busy with an active turn");

    expect(harness.sessionActivity).toEqual([]);
  });

  it("constructs the app-server service with the typed Forge host adapter", async () => {
    const harness = new CoordinatorHarness();
    harness.descriptors.delete(harness.sidecar.agentId);
    const coordinator = new CodexDirectSidecarCoordinator({
      dataDir: "/tmp/forge-data",
      host: harness.host,
    });

    const created = await coordinator.appServerService.getOrCreateSidecarDescriptor(
      harness.manager,
    );

    expect(created).toMatchObject({
      agentId: harness.sidecar.agentId,
      managerId: harness.manager.agentId,
      externalThread: { type: "codex_app_server", persisted: true },
    });
    expect(harness.descriptors.get(harness.sidecar.agentId)).toBe(created);
  });

  it("exposes distinct stop-preserve and terminate-cleanup lifecycle seams", async () => {
    const harness = new CoordinatorHarness();
    const interruptTurn = vi
      .spyOn(harness.appServerService, "interruptTurn")
      .mockResolvedValue(undefined);
    const cleanupTurnStateForTermination = vi
      .spyOn(harness.appServerService, "cleanupSidecarTurnStateForTermination")
      .mockResolvedValue(undefined);

    await harness.coordinator.interruptTurn(harness.sidecar.agentId);
    await harness.coordinator.cleanupTurnStateForTermination(harness.sidecar.agentId);

    expect(interruptTurn).toHaveBeenCalledWith(harness.sidecar.agentId);
    expect(cleanupTurnStateForTermination).toHaveBeenCalledWith(harness.sidecar.agentId);
    expect(harness.coordinator.isSidecarDescriptor(harness.sidecar)).toBe(true);
    expect(harness.coordinator.isSidecarDescriptor(harness.manager)).toBe(false);
  });
});

class CoordinatorHarness {
  readonly manager = createManagerDescriptor("/tmp/project", {
    agentId: "manager",
    profileId: "profile",
  }) as CodexDirectSidecarManager;
  readonly sidecar = createSidecarDescriptor("manager--codex", this.manager.agentId);
  readonly descriptors = new Map<string, AgentDescriptor>([
    [this.manager.agentId, this.manager],
    [this.sidecar.agentId, this.sidecar],
  ]);
  readonly trustPrompts: string[] = [];
  readonly sessionActivity: string[] = [];
  readonly appServerService = new CodexAppServerService(createNoopAppServerHost(), {
    dataDir: "/tmp/forge-data",
  });
  readonly getOrCreateSidecarDescriptor = vi
    .spyOn(this.appServerService, "getOrCreateSidecarDescriptor")
    .mockResolvedValue(this.sidecar);
  readonly sendTextTurn = vi
    .spyOn(this.appServerService, "sendTextTurn")
    .mockResolvedValue(undefined);
  readonly host: CodexDirectSidecarCoordinatorHost = {
    now: () => "2026-07-13T12:00:00.000Z",
    logDebug: vi.fn(),
    getDescriptor: (agentId) => this.descriptors.get(agentId),
    upsertDescriptor: (descriptor) => this.descriptors.set(descriptor.agentId, descriptor),
    saveStore: async () => {},
    ensureSessionFileParentDirectory: async () => {},
    emitConversationMessage: vi.fn(),
    emitConversationLog: vi.fn(),
    emitAgentMessage: vi.fn(),
    emitAgentToolCall: vi.fn(),
    emitStatus: vi.fn(),
    reportAttentionStatusTransition: vi.fn(async () => undefined),
    emitAgentsSnapshot: vi.fn(),
    emitProfilesSnapshot: vi.fn(),
    listWorkersForSession: (managerAgentId) =>
      Array.from(this.descriptors.values()).filter(
        (descriptor) => descriptor.managerId === managerAgentId && descriptor.role === "worker",
      ),
    listSessionsForProfile: (profileId) =>
      Array.from(this.descriptors.values()).filter(
        (descriptor) => descriptor.role === "manager" && descriptor.profileId === profileId,
      ),
    scheduleProjectExecutableTrustPrompt: (manager) => {
      this.trustPrompts.push(manager.agentId);
    },
    markSessionActivity: (agentId, timestamp) => {
      this.sessionActivity.push(`activity:${agentId}:${timestamp}`);
    },
    markSessionUserMessageActivity: (agentId, timestamp) => {
      this.sessionActivity.push(`user:${agentId}:${timestamp}`);
    },
  };
  readonly coordinator = new CodexDirectSidecarCoordinator({
    dataDir: "/tmp/forge-data",
    host: this.host,
    codexAppServerService: this.appServerService,
  });
}

function createNoopAppServerHost(): CodexSidecarHost {
  return {
    now: () => "2026-07-13T12:00:00.000Z",
    logDebug: () => {},
    getDescriptor: () => undefined,
    upsertDescriptor: () => {},
    saveStore: async () => {},
    ensureSessionFileParentDirectory: async () => {},
    appendConversationEntry: () => {},
    emitConversationMessage: () => {},
    emitConversationLog: () => {},
    emitAgentMessage: () => {},
    emitAgentToolCall: () => {},
    emitStatus: () => {},
    reportAttentionStatusTransition: async () => {},
    emitAgentsSnapshot: () => {},
    emitProfilesSnapshot: () => {},
    listWorkersForSession: () => [],
  };
}

function createSidecarDescriptor(agentId: string, managerId: string): AgentDescriptor {
  return {
    agentId,
    managerId,
    role: "worker",
    displayName: "Codex",
    status: "idle",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai", modelId: "codex-app-server", runtime: "codex_app_server" },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId: "profile",
    externalThread: { type: "codex_app_server", persisted: true, createdByMention: true },
  };
}

function createWorkerDescriptor(agentId: string, managerId: string): AgentDescriptor {
  return {
    ...createSidecarDescriptor(agentId, managerId),
    displayName: "Worker",
    model: { provider: "anthropic", modelId: "claude-sonnet-5", runtime: "pi" },
    externalThread: undefined,
  };
}
