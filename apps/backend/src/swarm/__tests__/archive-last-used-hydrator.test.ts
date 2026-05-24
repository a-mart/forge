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

function userToAgentMessage(timestamp: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: CONVERSATION_ENTRY_TYPE,
    data: {
      type: "agent_message",
      agentId: "session-1",
      source: "user_to_agent",
      toAgentId: "worker-1",
      text: "worker please",
      timestamp,
      ...overrides,
    },
  };
}

function legacyUserMessage(timestamp: string, text: string) {
  return {
    type: "message",
    id: `legacy-${timestamp}`,
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text }],
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

  it("hydrates legacy raw user messages while ignoring bootstrap system prompts", async () => {
    const file = await sessionFile([
      legacyUserMessage("2026-05-19T00:00:00.000Z", "SYSTEM: You are a newly created manager agent."),
      legacyUserMessage("2026-05-20T00:00:00.000Z", "Please investigate the archive view."),
      legacyUserMessage("2026-05-21T00:00:00.000Z", "SYSTEM: Runtime bootstrap context."),
      legacyUserMessage("2026-05-22T00:00:00.000Z", "Fix the regression."),
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
    expect(sessions.get("session-1")?.lastUserMessageAt).toBe("2026-05-22T00:00:00.000Z");
  });

  it("does not hydrate legacy bootstrap-only sessions", async () => {
    const file = await sessionFile([
      legacyUserMessage("2026-05-19T00:00:00.000Z", "SYSTEM: You are a newly created manager agent."),
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
      hydratedSessionCount: 0,
    });
    expect(sessions.get("session-1")?.lastUserMessageAt).toBeUndefined();
  });

  it("hydrates worker-targeted user messages from manager agent_message and worker transcript rows", async () => {
    const managerFile = await sessionFile([
      conversationMessage("2026-05-19T00:00:00.000Z"),
      userToAgentMessage("2026-05-21T00:00:00.000Z"),
    ]);
    const workerFile = await sessionFile([
      conversationMessage("2026-05-22T00:00:00.000Z", { agentId: "worker-1" }),
    ]);
    const sessions = new Map([["session-1", session({ sessionFile: managerFile })]]);
    const agents = new Map([
      ["session-1", session({ sessionFile: managerFile })],
      ["worker-1", session({
        agentId: "worker-1",
        managerId: "session-1",
        role: "worker",
        sessionFile: workerFile,
        profileId: undefined,
      })],
    ]);
    const hydrator = new ArchiveLastUsedHydrator({
      getAgent: (agentId) => agents.get(agentId),
      listSessions: () => Array.from(sessions.values()),
      listAgents: () => Array.from(agents.values()),
      listProfiles: () => [profile()],
      patchDescriptor: async (agentId, patch) => {
        const current = agents.get(agentId)!;
        const next = { ...current, ...patch };
        agents.set(agentId, next);
        if (sessions.has(agentId)) sessions.set(agentId, next);
        return next;
      },
    });

    await expect(hydrator.hydrateSessionIfMissing("session-1")).resolves.toEqual({
      scannedSessionCount: 1,
      hydratedSessionCount: 1,
    });
    expect(agents.get("session-1")?.lastUserMessageAt).toBe("2026-05-22T00:00:00.000Z");
  });

  it("lazy hydrates an archived project from worker-targeted user messages", async () => {
    const managerFile = await sessionFile([userToAgentMessage("2026-05-21T00:00:00.000Z")]);
    const workerFile = await sessionFile([conversationMessage("2026-05-23T00:00:00.000Z", { agentId: "worker-1" })]);
    const projectSession = session({ agentId: "project-child", profileId: "archived-project", sessionFile: managerFile });
    const workerDescriptor = session({
      agentId: "worker-1",
      managerId: "project-child",
      role: "worker",
      sessionFile: workerFile,
      profileId: undefined,
    });
    const sessions = new Map([["project-child", projectSession]]);
    const agents = new Map([["project-child", projectSession], ["worker-1", workerDescriptor]]);
    const hydrator = new ArchiveLastUsedHydrator({
      getAgent: (agentId) => agents.get(agentId),
      listSessions: () => Array.from(sessions.values()),
      listAgents: () => Array.from(agents.values()),
      listProfiles: () => [profile({ profileId: "archived-project", archivedAt: now })],
      patchDescriptor: async (agentId, patch) => {
        const current = agents.get(agentId)!;
        const next = { ...current, ...patch };
        agents.set(agentId, next);
        if (sessions.has(agentId)) sessions.set(agentId, next);
        return next;
      },
    });

    await expect(hydrator.hydrateArchivedRowsIfMissing()).resolves.toEqual({
      scannedSessionCount: 1,
      hydratedSessionCount: 1,
    });
    expect(agents.get("project-child")?.lastUserMessageAt).toBe("2026-05-23T00:00:00.000Z");
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
