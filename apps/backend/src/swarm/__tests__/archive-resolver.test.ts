import { describe, expect, it } from "vitest";
import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import {
  ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED_MESSAGE,
  ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED_MESSAGE,
  isProfileArchived,
  isSessionDirectlyArchivable,
  isSessionDirectlyArchived,
  isSessionEffectivelyArchived,
  resolveProfileRestoreOpenAgentId,
} from "../archive/archive-resolver.js";

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

describe("archive resolver", () => {
  it("keeps the exact archive error copy centralized", () => {
    expect(ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED_MESSAGE).toBe("The default session for a project can’t be archived directly.");
    expect(ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED_MESSAGE).toBe("Restore the project first.");
  });

  it("resolves direct and effective archive state", () => {
    expect(isProfileArchived(profile())).toBe(false);
    expect(isProfileArchived(profile({ archivedAt: now }))).toBe(true);
    expect(isSessionDirectlyArchived(session())).toBe(false);
    expect(isSessionDirectlyArchived(session({ archivedAt: now }))).toBe(true);
    expect(isSessionEffectivelyArchived({ session: session(), profile: profile() })).toBe(false);
    expect(isSessionEffectivelyArchived({ session: session({ archivedAt: now }), profile: profile() })).toBe(true);
    expect(isSessionEffectivelyArchived({ session: session(), profile: profile({ archivedAt: now }) })).toBe(true);
  });

  it("blocks direct archive for a profile default session", () => {
    expect(isSessionDirectlyArchivable({
      session: session({ agentId: "session-default" }),
      profile: profile(),
    })).toBe(false);
    expect(isSessionDirectlyArchivable({
      session: session({ agentId: "session-secondary" }),
      profile: profile(),
    })).toBe(true);
  });

  it("chooses the newest non-directly-archived session after profile restore", () => {
    expect(resolveProfileRestoreOpenAgentId({
      profile: profile(),
      sessions: [
        session({ agentId: "session-default", updatedAt: "2026-05-19T00:00:00.000Z" }),
        session({ agentId: "session-old", updatedAt: "2026-05-18T00:00:00.000Z" }),
        session({ agentId: "session-new-archived", updatedAt: "2026-05-21T00:00:00.000Z", archivedAt: now }),
        session({ agentId: "session-new", updatedAt: "2026-05-20T00:00:00.000Z" }),
      ],
    })).toBe("session-new");
  });

  it("does not select newer sessions from another profile after profile restore", () => {
    expect(resolveProfileRestoreOpenAgentId({
      profile: profile(),
      sessions: [
        session({ agentId: "session-default", updatedAt: "2026-05-19T00:00:00.000Z" }),
        session({
          agentId: "other-profile-newer",
          profileId: "profile-2",
          updatedAt: "2026-05-21T00:00:00.000Z",
        }),
        session({ agentId: "session-new", updatedAt: "2026-05-20T00:00:00.000Z" }),
      ],
    })).toBe("session-new");
  });

  it("falls back to the default session when every child in the profile is directly archived", () => {
    expect(resolveProfileRestoreOpenAgentId({
      profile: profile(),
      sessions: [
        session({ agentId: "session-old", updatedAt: "2026-05-18T00:00:00.000Z", archivedAt: now }),
        session({ agentId: "other-profile-active", profileId: "profile-2", updatedAt: "2026-05-21T00:00:00.000Z" }),
      ],
    })).toBe("session-default");
  });
});
