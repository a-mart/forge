import { describe, expect, it, vi } from "vitest";
import { createAgentDescriptor } from "../../test-support/index.js";
import {
  SwarmSessionService,
  type SwarmSessionServiceOptions,
} from "../swarm-session-service.js";

describe("SwarmSessionService shutdown safety", () => {
  it("does not dispose session files when any runtime shutdown is unconfirmed", async () => {
    const descriptor = createAgentDescriptor({
      agentId: "manager-delete-timeout",
      managerId: "manager-delete-timeout",
      profileId: "manager-delete-timeout",
      role: "manager",
      status: "stopped",
    });
    const disposeSession = vi.fn(async () => {});
    const service = new SwarmSessionService({
      getRequiredSessionDescriptor: vi.fn(() => descriptor),
      assertSessionIsDeletable: vi.fn(),
      stopSessionInternal: vi.fn(async () => ({
        terminatedWorkerIds: [],
        unsafeShutdownAgentIds: ["worker-delete-timeout"],
      })),
      provisioner: { disposeSession },
    } as unknown as SwarmSessionServiceOptions);

    await expect(service.deleteSession(descriptor.agentId)).rejects.toThrow(
      /could not safely delete.*worker-delete-timeout.*retry cleanup.*No session files were removed/i,
    );

    expect(disposeSession).not.toHaveBeenCalled();
  });

  it("copies a session context-mode override onto forks and leaves inherit absent", async () => {
    const source = createAgentDescriptor({
      agentId: "manager",
      managerId: "manager",
      profileId: "manager",
      role: "manager",
      contextModeOverride: "fresh",
    });
    const inheritSource = createAgentDescriptor({
      agentId: "manager-inherit",
      managerId: "manager-inherit",
      profileId: "manager",
      role: "manager",
    });
    const forked = createAgentDescriptor({
      agentId: "manager--fork",
      managerId: "manager--fork",
      profileId: "manager",
      role: "manager",
    });
    const inheritForked = createAgentDescriptor({
      agentId: "manager--inherit-fork",
      managerId: "manager--inherit-fork",
      profileId: "manager",
      role: "manager",
      contextModeOverride: "summary",
    });
    const profiles = new Map([["manager", {
      profileId: "manager",
      displayName: "Manager",
      defaultSessionAgentId: "manager",
      defaultModel: source.model,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    }]]);
    const descriptors = new Map([
      [source.agentId, source],
      [inheritSource.agentId, inheritSource],
      [forked.agentId, forked],
      [inheritForked.agentId, inheritForked],
    ]);
    const prepareSessionCreation = vi.fn((_profileId: string) => ({
      profile: profiles.get("manager")!,
      sessionDescriptor: descriptors.get(forked.agentId)!,
      sessionNumber: 2,
    }));
    const copySecureAccessForFork = vi.fn(async () => async () => undefined);
    const service = new SwarmSessionService({
      profiles,
      copySecureAccessForFork,
      getRequiredSessionDescriptor: (agentId: string) => descriptors.get(agentId)!,
      prepareSessionCreation,
      provisioner: { provisionSession: vi.fn(async (input) => {
        await input.beforeRuntime();
        expect(copySecureAccessForFork).toHaveBeenCalled();
        await input.initializeRuntime();
      }) },
      ensureEffectiveDelegationRoster: vi.fn(async () => undefined),
      saveStore: vi.fn(async () => undefined),
      emitSessionLifecycle: vi.fn(),
      emitAgentsSnapshot: vi.fn(),
      emitProfilesSnapshot: vi.fn(),
      copySessionHistoryForFork: vi.fn(async () => undefined),
      copyPinnedMessagesForFork: vi.fn(async () => undefined),
      writeForkedSessionMemoryHeader: vi.fn(async () => undefined),
      getOrCreateRuntimeForDescriptor: vi.fn(async () => ({ getContextUsage: () => undefined })),
      resolveGlobalDelegationRosterId: vi.fn(async () => "balanced"),
    } as unknown as SwarmSessionServiceOptions);

    const copied = await service.forkSession(source.agentId, { label: "Fork" });
    expect(copied.sessionAgent.contextModeOverride).toBe("fresh");
    expect(copySecureAccessForFork).toHaveBeenCalledWith(source.agentId, forked.agentId);

    prepareSessionCreation.mockImplementationOnce(() => ({
      profile: profiles.get("manager")!,
      sessionDescriptor: inheritForked,
      sessionNumber: 3,
    }));
    const inherited = await service.forkSession(inheritSource.agentId, { label: "Inherit fork" });
    expect(inherited.sessionAgent.contextModeOverride).toBeUndefined();
  });
});

describe("provisioning rollback ownership", () => {
  it.each(["pending", "failed", "cleanup_failed"] as const)(
    "retains the session ID and secure state when rollback is %s",
    async (failure) => {
      const { SessionProvisioner } = await import("../session-provisioner.js");
      const descriptor = createAgentDescriptor({
        agentId: "failed-fork", managerId: "failed-fork", profileId: "project", role: "manager",
      });
      const deleteDescriptor = vi.fn();
      const cleanupSecureState = vi.fn(async () => {
        if (failure === "cleanup_failed") throw new Error("secure cleanup failed");
      });
      const provisioner = new SessionProvisioner({
        runtimes: new Map([[descriptor.agentId, {}]]),
        runRuntimeShutdown: async () => failure === "cleanup_failed"
          ? { status: "clean" }
          : failure === "pending" ? { status: "pending" }
            : { status: "failed", error: new Error("runtime cleanup failed") },
        detachRuntime: vi.fn(),
        descriptorMutations: { deleteDescriptor },
        logDebug: vi.fn(),
      } as unknown as ConstructorParameters<typeof SessionProvisioner>[0]);

      await expect(provisioner.rollbackCreatedSession(descriptor, {
        beforeRemoval: cleanupSecureState,
      })).resolves.toMatchObject({ status: "retained" });
      expect(deleteDescriptor).not.toHaveBeenCalled();
      expect(cleanupSecureState).toHaveBeenCalledTimes(failure === "cleanup_failed" ? 1 : 0);
    },
  );
});
