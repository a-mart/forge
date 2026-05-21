import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { ArchiveOperationError, ArchiveService } from "../archive/archive-service.js";
import { resolveProfileRestoreOpenAgentId } from "../archive/archive-resolver.js";

const model = { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" };
const now = "2026-05-20T00:00:00.000Z";

function profile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "profile-1",
    displayName: "Project",
    defaultSessionAgentId: "session-default",
    defaultModel: model,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function session(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "session-1",
    managerId: "session-1",
    displayName: "Session",
    role: "manager",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: "/tmp",
    model,
    sessionFile: "/tmp/session.jsonl",
    profileId: "profile-1",
    ...overrides,
  };
}

function createHarness(input?: {
  profiles?: ManagerProfile[];
  sessions?: AgentDescriptor[];
  stopMutatesUpdatedAt?: string;
  stopRejectAgentIds?: string[];
}) {
  const profiles = new Map((input?.profiles ?? [profile()]).map((item) => [item.profileId, item]));
  const sessions = new Map((input?.sessions ?? [session()]).map((item) => [item.agentId, item]));
  const stopSession = vi.fn(async (agentId: string) => {
    if (input?.stopMutatesUpdatedAt) {
      const current = sessions.get(agentId);
      if (current) {
        sessions.set(agentId, { ...current, updatedAt: input.stopMutatesUpdatedAt });
      }
    }
    if (input?.stopRejectAgentIds?.includes(agentId)) {
      throw new Error(`stop failed for ${agentId}`);
    }
    return { terminatedWorkerIds: [`${agentId}-worker`] };
  });
  const onProfileArchiveStopError = vi.fn();
  const service = new ArchiveService({
    now: () => now,
    getAgent: (agentId) => sessions.get(agentId),
    getProfile: (profileId) => profiles.get(profileId),
    listSessions: () => Array.from(sessions.values()),
    patchDescriptor: vi.fn(async (agentId, patch) => {
      const current = sessions.get(agentId);
      if (!current) throw new Error(`Unknown descriptor: ${agentId}`);
      const next = typeof patch === "function" ? patch({ ...current }) : { ...current, ...patch, agentId };
      sessions.set(agentId, next);
      return next;
    }),
    patchProfile: vi.fn(async (profileId, patch) => {
      const current = profiles.get(profileId);
      if (!current) throw new Error(`Unknown profile: ${profileId}`);
      const next = typeof patch === "function" ? patch({ ...current }) : { ...current, ...patch, profileId };
      profiles.set(profileId, next);
      return next;
    }),
    stopSession,
    onProfileArchiveStopError,
  });

  return { service, profiles, sessions, stopSession, onProfileArchiveStopError };
}

describe("archive service", () => {
  it("archives a non-default session by setting archivedAt and stopping the live runtime", async () => {
    const { service, sessions, stopSession } = createHarness({
      sessions: [session({ agentId: "session-secondary" })],
    });

    await expect(service.archiveSession("session-secondary")).resolves.toEqual({
      agentId: "session-secondary",
      profileId: "profile-1",
      archivedAt: now,
      terminatedWorkerIds: ["session-secondary-worker"],
    });
    expect(sessions.get("session-secondary")?.archivedAt).toBe(now);
    expect(stopSession).toHaveBeenCalledWith("session-secondary");
  });

  it("preserves direct-session pre-archive recency when stopping mutates updatedAt", async () => {
    const { service, sessions, profiles } = createHarness({
      stopMutatesUpdatedAt: "2026-05-23T00:00:00.000Z",
      sessions: [
        session({ agentId: "session-default", updatedAt: "2026-05-18T00:00:00.000Z" }),
        session({ agentId: "session-older", updatedAt: "2026-05-19T00:00:00.000Z" }),
        session({ agentId: "session-newer", updatedAt: "2026-05-20T00:00:00.000Z" }),
      ],
    });

    await service.archiveSession("session-older");
    expect(sessions.get("session-older")?.updatedAt).toBe("2026-05-19T00:00:00.000Z");

    await service.restoreSession("session-older");
    expect(sessions.get("session-older")?.updatedAt).toBe("2026-05-19T00:00:00.000Z");
    expect(resolveProfileRestoreOpenAgentId({
      profile: profiles.get("profile-1")!,
      sessions: Array.from(sessions.values()),
    })).toBe("session-newer");
  });

  it("rejects direct archive of the profile default session with the public error code and copy", async () => {
    const { service } = createHarness({
      sessions: [session({ agentId: "session-default" })],
    });

    await expect(service.archiveSession("session-default")).rejects.toMatchObject({
      code: "ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED",
      message: "The default session for a project can’t be archived directly.",
    } satisfies Partial<ArchiveOperationError>);
  });

  it("restores a directly archived session by clearing only the session flag", async () => {
    const { service, sessions } = createHarness({
      sessions: [session({ agentId: "session-secondary", archivedAt: now })],
    });

    await expect(service.restoreSession("session-secondary")).resolves.toEqual({
      agentId: "session-secondary",
      profileId: "profile-1",
      openAgentId: "session-secondary",
    });
    expect(sessions.get("session-secondary")?.archivedAt).toBeUndefined();
  });

  it("blocks direct session restore while the parent profile is archived", async () => {
    const { service, sessions } = createHarness({
      profiles: [profile({ archivedAt: now })],
      sessions: [session({ agentId: "session-secondary", archivedAt: now })],
    });

    await expect(service.restoreSession("session-secondary")).rejects.toMatchObject({
      code: "ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED",
      message: "Restore the project first.",
    } satisfies Partial<ArchiveOperationError>);
    expect(sessions.get("session-secondary")?.archivedAt).toBe(now);
  });

  it("archives a profile by setting only the profile flag and stopping live sessions", async () => {
    const { service, profiles, sessions, stopSession } = createHarness({
      sessions: [
        session({ agentId: "session-default", status: "idle" }),
        session({ agentId: "session-secondary", status: "streaming" }),
        session({ agentId: "session-stopped", status: "stopped" }),
        session({ agentId: "other-profile", profileId: "profile-2", status: "streaming" }),
      ],
    });

    await expect(service.archiveProfile("profile-1")).resolves.toEqual({
      profileId: "profile-1",
      archivedAt: now,
      terminatedWorkerIds: ["session-default-worker", "session-secondary-worker"],
    });
    expect(profiles.get("profile-1")?.archivedAt).toBe(now);
    expect(sessions.get("session-default")?.archivedAt).toBeUndefined();
    expect(sessions.get("session-secondary")?.archivedAt).toBeUndefined();
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledWith("session-default");
    expect(stopSession).toHaveBeenCalledWith("session-secondary");
  });

  it("keeps a committed profile archive successful when one child session fails to stop", async () => {
    const { service, profiles, stopSession, onProfileArchiveStopError } = createHarness({
      sessions: [
        session({ agentId: "session-default", status: "idle" }),
        session({ agentId: "session-fails", status: "streaming" }),
        session({ agentId: "session-later", status: "streaming" }),
      ],
      stopRejectAgentIds: ["session-fails"],
    });

    await expect(service.archiveProfile("profile-1")).resolves.toEqual({
      profileId: "profile-1",
      archivedAt: now,
      terminatedWorkerIds: ["session-default-worker", "session-later-worker"],
    });
    expect(profiles.get("profile-1")?.archivedAt).toBe(now);
    expect(stopSession).toHaveBeenCalledTimes(3);
    expect(stopSession).toHaveBeenNthCalledWith(1, "session-default");
    expect(stopSession).toHaveBeenNthCalledWith(2, "session-fails");
    expect(stopSession).toHaveBeenNthCalledWith(3, "session-later");
    expect(onProfileArchiveStopError).toHaveBeenCalledTimes(1);
    expect(onProfileArchiveStopError).toHaveBeenCalledWith("session-fails", expect.any(Error));
  });

  it("installs the profile archive gate before stopping child sessions", async () => {
    const profiles = new Map([["profile-1", profile()]]);
    const sessions = new Map([
      ["session-default", session({ agentId: "session-default", status: "streaming" })],
    ]);
    const stopSession = vi.fn(async () => {
      expect(profiles.get("profile-1")?.archivedAt).toBe(now);
      return { terminatedWorkerIds: [] };
    });
    const service = new ArchiveService({
      now: () => now,
      getAgent: (agentId) => sessions.get(agentId),
      getProfile: (profileId) => profiles.get(profileId),
      listSessions: () => Array.from(sessions.values()),
      patchDescriptor: vi.fn(async (agentId, patch) => {
        const current = sessions.get(agentId);
        if (!current) throw new Error(`Unknown descriptor: ${agentId}`);
        const next = typeof patch === "function" ? patch({ ...current }) : { ...current, ...patch, agentId };
        sessions.set(agentId, next);
        return next;
      }),
      patchProfile: vi.fn(async (profileId, patch) => {
        const current = profiles.get(profileId);
        if (!current) throw new Error(`Unknown profile: ${profileId}`);
        const next = typeof patch === "function" ? patch({ ...current }) : { ...current, ...patch, profileId };
        profiles.set(profileId, next);
        return next;
      }),
      stopSession,
    });

    await service.archiveProfile("profile-1");
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it("preserves pre-archive session recency when stopping sessions mutates updatedAt", async () => {
    const { service } = createHarness({
      profiles: [profile()],
      stopMutatesUpdatedAt: "2026-05-23T00:00:00.000Z",
      sessions: [
        session({ agentId: "session-default", updatedAt: "2026-05-18T00:00:00.000Z" }),
        session({ agentId: "session-older", updatedAt: "2026-05-19T00:00:00.000Z" }),
        session({ agentId: "session-new", updatedAt: "2026-05-20T00:00:00.000Z" }),
      ],
    });

    await service.archiveProfile("profile-1");
    await expect(service.restoreProfile("profile-1")).resolves.toEqual({
      profileId: "profile-1",
      openAgentId: "session-new",
    });
  });

  it("restores a profile and opens the newest non-directly-archived session in that profile", async () => {
    const { service, profiles } = createHarness({
      profiles: [profile({ archivedAt: now })],
      sessions: [
        session({ agentId: "session-default", updatedAt: "2026-05-18T00:00:00.000Z" }),
        session({ agentId: "session-archived-newer", updatedAt: "2026-05-21T00:00:00.000Z", archivedAt: now }),
        session({ agentId: "session-new", updatedAt: "2026-05-20T00:00:00.000Z" }),
        session({ agentId: "other-profile-newer", profileId: "profile-2", updatedAt: "2026-05-22T00:00:00.000Z" }),
      ],
    });

    await expect(service.restoreProfile("profile-1")).resolves.toEqual({
      profileId: "profile-1",
      openAgentId: "session-new",
    });
    expect(profiles.get("profile-1")?.archivedAt).toBeUndefined();
  });

  it("restores a profile with default-session fallback when all profile children are directly archived", async () => {
    const { service } = createHarness({
      profiles: [profile({ archivedAt: now })],
      sessions: [
        session({ agentId: "session-secondary", archivedAt: now }),
        session({ agentId: "other-profile-newer", profileId: "profile-2", updatedAt: "2026-05-22T00:00:00.000Z" }),
      ],
    });

    await expect(service.restoreProfile("profile-1")).resolves.toEqual({
      profileId: "profile-1",
      openAgentId: "session-default",
    });
  });
});
