import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { describe, expect, it } from "vitest";
import type { SwarmManager } from "../../swarm-manager.js";
import { LocalRemoteUpdateAwarenessService } from "../../../ws/http/services/remote-update-awareness-service.js";
import { RemoteUpdateAwarenessService } from "../remote-update-awareness-service.js";
import { createTestStore } from "./test-helpers.js";

function profile(archivedAt?: string): ManagerProfile {
  return {
    profileId: "project", displayName: "Project", defaultSessionAgentId: "session",
    defaultModel: { provider: "test", modelId: "test", thinkingLevel: "off" },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...(archivedAt ? { archivedAt } : {}),
  };
}

const descriptor = {
  agentId: "session", managerId: "session", displayName: "Session", role: "manager",
  status: "idle", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  cwd: "/repo", model: { provider: "test", modelId: "test", thinkingLevel: "off" },
  sessionFile: "/session.jsonl", profileId: "project",
} satisfies AgentDescriptor;

describe("remote update awareness archive lifecycle", () => {
  it("promptly excludes archives, retains preferences, and restores without an immediate observation", async () => {
    const { database, store } = await createTestStore();
    const core = new RemoteUpdateAwarenessService(store);
    let profiles = [profile()];
    const events: unknown[] = [];
    const manager = {
      getConfig: () => ({ runtimeTarget: "builder", paths: {} }),
      listProfiles: () => profiles,
      getAgent: (agentId: string) => agentId === descriptor.agentId ? descriptor : undefined,
    } as unknown as SwarmManager;
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: manager,
      coreService: core,
      isGitProject: async () => true,
      broadcastProjectEvent: (_projectId, event) => events.push(event),
    });
    await service.start();
    service.setProjectOverride("project", "on");
    service.setGlobalEnabled(true);

    profiles = [profile("2026-07-20T00:00:00.000Z")];
    await service.reconcileProjects();
    expect(() => service.getProjectSnapshot("project")).toThrow("Unknown, archived, or non-Git");
    expect(events).toContainEqual({
      type: "remote_update_awareness_project_cleared",
      projectId: "project",
    });

    profiles = [profile()];
    await service.reconcileProjects();
    expect(service.getProjectSnapshot("project")).toMatchObject({
      override: "on",
      globalEnabled: true,
      effectiveEnabled: true,
      state: "unobserved",
    });
    expect(core.getProjectRecord("project")?.lastCompletedObservedAt).toBeNull();

    await service.stop();
    database.close();
  });

  it("keeps the global master authoritative over an explicit project-on override", async () => {
    const { database, store } = await createTestStore();
    const manager = {
      getConfig: () => ({ runtimeTarget: "builder", paths: {} }),
      listProfiles: () => [profile()],
      getAgent: () => descriptor,
    } as unknown as SwarmManager;
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: manager,
      coreService: new RemoteUpdateAwarenessService(store),
      isGitProject: async () => true,
    });
    await service.start();
    service.setProjectOverride("project", "on");
    expect(service.getProjectSnapshot("project")).toMatchObject({
      override: "on", globalEnabled: false, effectiveEnabled: false, state: "disabled",
    });
    await service.stop();
    database.close();
  });
});
