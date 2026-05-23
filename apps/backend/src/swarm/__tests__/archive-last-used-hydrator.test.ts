import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";
import { CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { ArchiveLastUsedHydrator } from "../archive/archive-last-used-hydrator.js";

const model = { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" };
const now = "2026-05-20T00:00:00.000Z";

function profile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "profile-1",
    displayName: "Project",
    defaultSessionAgentId: "session-1",
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

async function sessionFile(lines: unknown[]): Promise<string> {
  const dir = join(tmpdir(), `forge-archive-last-used-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  await writeFile(file, `${lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

function conversationMessage(timestamp: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: CONVERSATION_ENTRY_TYPE,
    data: {
      type: "conversation_message",
      agentId: "session-1",
      role: "user",
      source: "user_input",
      text: "hello",
      timestamp,
      ...overrides,
    },
  };
}

describe("ArchiveLastUsedHydrator", () => {
  it("hydrates a missing session value from the latest real user input message", async () => {
    const file = await sessionFile([
      "not json",
      conversationMessage("2026-05-19T00:00:00.000Z"),
      conversationMessage("2026-05-23T00:00:00.000Z", { role: "assistant" }),
      conversationMessage("2026-05-22T00:00:00.000Z", { source: "project_agent_input" }),
      conversationMessage("2026-05-21T00:00:00.000Z"),
    ]);
    const sessions = new Map([["session-1", session({ sessionFile: file })]]);
    const hydrator = new ArchiveLastUsedHydrator({
      getAgent: (agentId) => sessions.get(agentId),
      listSessions: () => Array.from(sessions.values()),
      listProfiles: () => [profile()],
      patchDescriptor: async (agentId, patch) => {
        const current = sessions.get(agentId)!;
        const next = { ...current, ...patch };
        sessions.set(agentId, next);
        return next;
      },
    });

    await expect(hydrator.hydrateSessionIfMissing("session-1")).resolves.toEqual({
      scannedSessionCount: 1,
      hydratedSessionCount: 1,
    });
    expect(sessions.get("session-1")?.lastUserMessageAt).toBe("2026-05-21T00:00:00.000Z");
  });

  it("lazy hydrates only archived rows and archived project children", async () => {
    const archivedFile = await sessionFile([conversationMessage("2026-05-21T00:00:00.000Z")]);
    const archivedProjectFile = await sessionFile([conversationMessage("2026-05-22T00:00:00.000Z")]);
    const activeFile = await sessionFile([conversationMessage("2026-05-23T00:00:00.000Z")]);
    const sessions = new Map([
      ["direct", session({ agentId: "direct", sessionFile: archivedFile, archivedAt: now })],
      ["project-child", session({ agentId: "project-child", profileId: "archived-project", sessionFile: archivedProjectFile })],
      ["active", session({ agentId: "active", profileId: "active-project", sessionFile: activeFile })],
    ]);
    const hydrator = new ArchiveLastUsedHydrator({
      getAgent: (agentId) => sessions.get(agentId),
      listSessions: () => Array.from(sessions.values()),
      listProfiles: () => [profile({ profileId: "archived-project", archivedAt: now }), profile({ profileId: "active-project" })],
      patchDescriptor: async (agentId, patch) => {
        const current = sessions.get(agentId)!;
        const next = { ...current, ...patch };
        sessions.set(agentId, next);
        return next;
      },
    });

    await expect(hydrator.hydrateArchivedRowsIfMissing()).resolves.toEqual({
      scannedSessionCount: 2,
      hydratedSessionCount: 2,
    });
    expect(sessions.get("direct")?.lastUserMessageAt).toBe("2026-05-21T00:00:00.000Z");
    expect(sessions.get("project-child")?.lastUserMessageAt).toBe("2026-05-22T00:00:00.000Z");
    expect(sessions.get("active")?.lastUserMessageAt).toBeUndefined();
  });
});
