import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXISTING_AGENTS_SECTION_CHAR_BUDGET,
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext,
  MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS,
  MAX_RECENT_SESSION_COUNT,
  RECENT_SESSIONS_SECTION_CHAR_BUDGET,
  scanRecentSessions
} from "../agent-creator-context.js";
import type { AgentDescriptor } from "../types.js";

function makeManagerDescriptor(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId">
): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: "manager",
    managerId: overrides.managerId ?? overrides.agentId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: overrides.sessionFile ?? `/tmp/${overrides.agentId}.jsonl`,
    profileId: overrides.profileId ?? "manager",
    sessionLabel: overrides.sessionLabel,
    sessionPurpose: overrides.sessionPurpose,
    projectAgent: overrides.projectAgent,
    archetypeId: overrides.archetypeId
  };
}

async function writeSessionFixture(
  dataDir: string,
  profileId: string,
  sessionId: string,
  options: {
    label?: string;
    mtimeMs: number;
  }
): Promise<void> {
  const sessionDir = join(dataDir, "profiles", profileId, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const metaPath = join(sessionDir, "meta.json");

  await writeFile(
    metaPath,
    JSON.stringify({
      label: options.label ?? sessionId
    }),
    "utf8"
  );

  const date = new Date(options.mtimeMs);
  await utimes(metaPath, date, date);
}

describe("agent-creator-context", () => {
  it("formats lightweight seed context with cwd, agents, and recent sessions", () => {
    const empty = formatAgentCreatorContextMessage({
      projectCwd: "/tmp/project",
      existingAgents: [],
      recentSessions: []
    });

    expect(empty).toContain("<agent_creator_seed_context>");
    expect(empty).toContain("projectCwd: /tmp/project");
    expect(empty).toContain("No project agents configured in this profile yet.");
    expect(empty).toContain("No recent sessions found.");

    const populated = formatAgentCreatorContextMessage({
      projectCwd: "/repo/forge",
      existingAgents: [
        {
          handle: "backend-specialist",
          whenToUse: "Use for backend correctness and route debugging."
        }
      ],
      recentSessions: [
        {
          sessionId: "session-a",
          label: "Release Work"
        }
      ]
    });

    expect(populated).toContain("projectCwd: /repo/forge");
    expect(populated).toContain("- @backend-specialist: Use for backend correctness and route debugging.");
    expect(populated).toContain("- Release Work (sessionId: session-a)");
  });

  it("caps the formatted seed context while preserving the closing tag", () => {
    const message = formatAgentCreatorContextMessage({
      projectCwd: "/repo/forge",
      existingAgents: Array.from({ length: 40 }, (_, index) => ({
        handle: `agent-${index + 1}`,
        whenToUse: `Use agent ${index + 1} for ${"routing ".repeat(20)}`
      })),
      recentSessions: Array.from({ length: MAX_RECENT_SESSION_COUNT }, (_, index) => ({
        sessionId: `session-${index + 1}`,
        label: `Session ${index + 1} ${"context ".repeat(8)}`
      }))
    });

    expect(message.length).toBeLessThanOrEqual(MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS);
    expect(message).toContain("</existing_project_agents>");
    expect(message).toContain("</recent_sessions>");
    expect(message).toContain("additional project agents omitted to stay within context budget");
    expect(message).toContain("additional recent sessions omitted to stay within context budget");
    expect(message).toContain("</agent_creator_seed_context>");
    expect(message.length).toBeGreaterThan(EXISTING_AGENTS_SECTION_CHAR_BUDGET);
    expect(message.length).toBeGreaterThan(RECENT_SESSIONS_SECTION_CHAR_BUDGET);
  });

  it("scans recent sessions by recency, excluding the creator session and enforcing the scan cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-creator-context-"));
    const dataDir = join(root, "data");
    const profileId = "manager";
    const baseTime = Date.parse("2026-03-01T00:00:00.000Z");

    for (let index = 0; index < MAX_RECENT_SESSION_COUNT + 5; index += 1) {
      await writeSessionFixture(dataDir, profileId, `session-${index + 1}`, {
        label: `Session ${index + 1}`,
        mtimeMs: baseTime + index * 1000
      });
    }

    await writeSessionFixture(dataDir, profileId, "creator-session", {
      label: "Creator Session",
      mtimeMs: baseTime + 100_000
    });

    const scanned = await scanRecentSessions(dataDir, profileId, "creator-session");

    expect(scanned.some((entry) => entry.sessionId === "creator-session")).toBe(false);
    expect(scanned.length).toBe(MAX_RECENT_SESSION_COUNT);
    expect(scanned[0]).toMatchObject({
      sessionId: `session-${MAX_RECENT_SESSION_COUNT + 5}`,
      label: `Session ${MAX_RECENT_SESSION_COUNT + 5}`
    });
    expect(scanned[scanned.length - 1]).toMatchObject({
      sessionId: "session-6",
      label: "Session 6"
    });
  });

  it("gathers project-agent routing summaries, recent session labels, and the creator cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-creator-context-"));
    const dataDir = join(root, "data");
    const profileId = "manager";

    await writeSessionFixture(dataDir, profileId, "qa-session", {
      label: "QA Session",
      mtimeMs: Date.parse("2026-03-02T00:00:00.000Z")
    });

    const descriptors: AgentDescriptor[] = [
      makeManagerDescriptor({
        agentId: "creator-session",
        sessionLabel: "Agent Creator",
        sessionPurpose: "agent_creator",
        cwd: "/repo/forge"
      }),
      makeManagerDescriptor({
        agentId: "backend-specialist--s2",
        sessionLabel: "Backend Specialist",
        projectAgent: {
          handle: "backend-specialist",
          whenToUse: "Use for backend correctness and route debugging.",
          systemPrompt: "Backend specialist focused on APIs."
        }
      })
    ];

    const context = await gatherAgentCreatorContext(dataDir, profileId, descriptors, "creator-session");

    expect(context.projectCwd).toBe("/repo/forge");
    expect(context.existingAgents).toEqual([
      {
        handle: "backend-specialist",
        whenToUse: "Use for backend correctness and route debugging."
      }
    ]);
    expect(context.recentSessions).toHaveLength(1);
    expect(context.recentSessions[0]).toMatchObject({
      sessionId: "qa-session",
      label: "QA Session"
    });
  });
});
