import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SwarmManager } from "../../swarm-manager.js";
import { LocalRemoteUpdateAwarenessService } from "../../../ws/http/services/remote-update-awareness-service.js";
import { RemoteUpdateAwarenessService } from "../remote-update-awareness-service.js";
import { createTestStore, target } from "./test-helpers.js";

const profile: ManagerProfile = {
  profileId: "project", displayName: "Project", defaultSessionAgentId: "session",
  defaultModel: { provider: "test", modelId: "test", thinkingLevel: "off" },
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};
const agent = {
  agentId: "session", managerId: "session", displayName: "Session", role: "manager",
  status: "idle", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), cwd: "/repo",
  model: { provider: "test", modelId: "test", thinkingLevel: "off" }, sessionFile: "/session.jsonl", profileId: "project",
} satisfies AgentDescriptor;

describe("remote update awareness Incoming projection", () => {
  it("keeps observation truth after exact dismissal and exposes only bounded sanitized evidence", async () => {
    const { database, store } = await createTestStore();
    store.setGlobalEnabled(true);
    const resolved = target({ remoteName: "upstream", targetRef: "refs/heads/trunk", destinationRef: "refs/remotes/upstream/trunk" });
    store.recordObservation("project", resolved, { state: "equal", tipOid: "a".repeat(40), observedAt: "2026-07-20T00:00:00.000Z" });
    store.recordObservation("project", resolved, { state: "remote_ahead", tipOid: "b".repeat(40), observedAt: "2026-07-20T00:01:00.000Z" });
    const run = vi.fn(async (args: string[]) => args[0] === "log"
      ? { stdout: "1752969600\0Subject\nwith control\0", stderr: "", exitCode: 0 }
      : { stdout: "A\0secret/path.txt\0R100\0old-secret.txt\0new-secret.txt\0", stderr: "", exitCode: 0 });
    const manager = {
      getConfig: () => ({ runtimeTarget: "builder", paths: {} }),
      listProfiles: () => [profile],
      getAgent: () => agent,
    } as unknown as SwarmManager;
    const service = new LocalRemoteUpdateAwarenessService({
      swarmManager: manager,
      coreService: new RemoteUpdateAwarenessService(store),
      gitFactory: () => ({ run } as never),
      isGitProject: async () => true,
    });
    await service.start();

    const before = await service.getIncoming("project");
    expect(before).toMatchObject({
      state: "update_available", attentionRequired: true,
      remoteDisplayName: "upstream", defaultBranchDisplay: "trunk",
      observedTipOid: "b".repeat(40), generation: 2,
      commits: { commitCount: 1, commitLimit: 20, hasMore: false },
      fileChanges: { changedFileCount: 2, changedFileCountLimit: 500, addedCount: 1, renamedCount: 1 },
    });
    expect(before.commits.commits[0]?.subject).toBe("Subject with control");
    expect(JSON.stringify(before)).not.toContain("secret/path.txt");
    expect(JSON.stringify(before)).not.toContain("old-secret.txt");

    service.dismissProject("project", 2);
    const after = await service.getIncoming("project");
    expect(after.state).toBe("update_available");
    expect(after.attentionRequired).toBe(false);
    expect(after.generation).toBe(2);
    await service.stop();
    database.close();
  });
});
