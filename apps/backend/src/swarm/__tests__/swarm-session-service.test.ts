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
      /could not safely delete.*worker-delete-timeout.*restart Forge.*No session files were removed/i,
    );

    expect(disposeSession).not.toHaveBeenCalled();
  });
});
