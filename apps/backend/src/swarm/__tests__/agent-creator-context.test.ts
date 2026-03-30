import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractStructuredMemoryContent,
  EXISTING_AGENTS_SECTION_CHAR_BUDGET,
  formatAgentCreatorContextMessage,
  gatherAgentCreatorContext,
  GLOBAL_SESSION_MEMORIES_BUDGET,
  MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS,
  MAX_SESSION_SCAN_COUNT,
  PER_SESSION_CHAR_BUDGET,
  scanRecentSessionMemories
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
    memory: string;
    mtimeMs: number;
  }
): Promise<void> {
  const sessionDir = join(dataDir, "profiles", profileId, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const memoryPath = join(sessionDir, "memory.md");
  const metaPath = join(sessionDir, "meta.json");

  await writeFile(memoryPath, options.memory, "utf8");
  await writeFile(
    metaPath,
    JSON.stringify({
      label: options.label ?? sessionId
    }),
    "utf8"
  );

  const date = new Date(options.mtimeMs);
  await utimes(memoryPath, date, date);
}

describe("agent-creator-context", () => {
  it("returns null for placeholder-only memory content", () => {
    const raw = `# Swarm Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)

## Decisions
- (none yet)

## Open Follow-ups
- (none yet)

## Learnings
- (none yet)`;

    expect(extractStructuredMemoryContent(raw, PER_SESSION_CHAR_BUDGET)).toBeNull();
  });

  it("extracts structured content in priority order and enforces the per-session budget", () => {
    const raw = `# Swarm Memory

## Project Facts
- API lives in apps/backend
- WS routes are in apps/backend/src/ws/routes

## Decisions
- Preserve current websocket event shapes

## Learnings
- Typecheck apps/backend before finishing`;

    const excerpt = extractStructuredMemoryContent(raw, 90);
    expect(excerpt).toBeTruthy();
    expect(excerpt).toContain("- API lives in apps/backend");
    expect(excerpt).toContain("- WS routes are in apps/backend/src/ws/routes");
    expect(excerpt!.length).toBeLessThanOrEqual(90);
  });

  it("formats empty and populated context blocks", () => {
    const empty = formatAgentCreatorContextMessage({
      existingAgents: [],
      sessionMemories: []
    });

    expect(empty).toContain("<existing_project_agents>");
    expect(empty).toContain("No project agents configured in this profile yet.");
    expect(empty).toContain("No recent session memories with usable content found.");

    const populated = formatAgentCreatorContextMessage({
      existingAgents: [
        {
          handle: "backend-specialist",
          displayName: "Backend Specialist",
          whenToUse: "Use for backend correctness and route debugging.",
          systemPromptExcerpt: "Backend specialist focused on APIs, persistence, and runtime behavior."
        }
      ],
      sessionMemories: [
        {
          sessionId: "session-a",
          label: "Release Work",
          excerpt: "- Release workflow uses draft GitHub releases first."
        }
      ]
    });

    expect(populated).toContain("- Backend Specialist (@backend-specialist)");
    expect(populated).toContain("whenToUse: Use for backend correctness and route debugging.");
    expect(populated).toContain("systemPromptFocus: Backend specialist focused on APIs, persistence, and runtime behavior.");
    expect(populated).toContain('Session "Release Work":');
  });

  it("caps the formatted context message based on full rendered output, including existing-agent summaries", () => {
    const message = formatAgentCreatorContextMessage({
      existingAgents: Array.from({ length: 20 }, (_, index) => ({
        handle: `agent-${index + 1}`,
        displayName: `Agent ${index + 1}`,
        whenToUse: `Use agent ${index + 1} for ${"routing ".repeat(25)}`,
        systemPromptExcerpt: `Focus ${index + 1}: ${"context ".repeat(18)}`
      })),
      sessionMemories: Array.from({ length: MAX_SESSION_SCAN_COUNT }, (_, index) => ({
        sessionId: `session-${index + 1}`,
        label: `Session ${index + 1}`,
        excerpt: `- Memory ${index + 1}: ${"x".repeat(260)}`
      }))
    });

    expect(message.length).toBeLessThanOrEqual(MAX_AGENT_CREATOR_CONTEXT_MESSAGE_CHARS);
    expect(message).toContain("</existing_project_agents>");
    expect(message).toContain("</recent_session_context>");
    expect(message).toContain("additional project agents omitted to stay within context budget");
    expect(message).toContain("Session \"Session 1\":");
    expect(message.length).toBeGreaterThan(EXISTING_AGENTS_SECTION_CHAR_BUDGET);
  });

  it("scans recent session memories with placeholder skipping, exclude filtering, scan cap, and global budget enforcement", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-creator-context-"));
    const dataDir = join(root, "data");
    const profileId = "manager";
    const baseTime = Date.parse("2026-03-01T00:00:00.000Z");

    for (let index = 0; index < MAX_SESSION_SCAN_COUNT + 5; index += 1) {
      await writeSessionFixture(dataDir, profileId, `session-${index + 1}`, {
        label: `Session ${index + 1}`,
        memory: `# Swarm Memory

## Project Facts
- Fact ${index + 1}: ${"x".repeat(12)}

## Decisions
- Decision ${index + 1}: ${"y".repeat(12)}`,
        mtimeMs: baseTime + index * 1000
      });
    }

    await writeSessionFixture(dataDir, profileId, "creator-session", {
      label: "Creator Session",
      memory: `# Swarm Memory

## Project Facts
- This should be excluded`,
      mtimeMs: baseTime + 100_000
    });

    await writeSessionFixture(dataDir, profileId, "placeholder-session", {
      label: "Placeholder Session",
      memory: `# Swarm Memory

## Project Facts
- (none yet)

## Decisions
- (none yet)`,
      mtimeMs: baseTime - 1_000
    });

    const scanned = await scanRecentSessionMemories(dataDir, profileId, "creator-session");

    expect(scanned.some((entry) => entry.sessionId === "creator-session")).toBe(false);
    expect(scanned.some((entry) => entry.sessionId === "placeholder-session")).toBe(false);
    expect(scanned.length).toBe(MAX_SESSION_SCAN_COUNT);
    expect(scanned[0]?.sessionId).toBe(`session-${MAX_SESSION_SCAN_COUNT + 5}`);
    expect(scanned[scanned.length - 1]?.sessionId).toBe("session-6");
    expect(scanned.every((entry) => entry.excerpt.length <= PER_SESSION_CHAR_BUDGET)).toBe(true);
    expect(scanned.reduce((sum, entry) => sum + entry.excerpt.length, 0)).toBeLessThanOrEqual(
      GLOBAL_SESSION_MEMORIES_BUDGET
    );
  });

  it("gathers project-agent summaries and recent memory excerpts together", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-creator-context-"));
    const dataDir = join(root, "data");
    const profileId = "manager";

    await writeSessionFixture(dataDir, profileId, "qa-session", {
      label: "QA Session",
      memory: `# Swarm Memory

## Decisions
- Validate fixes with vitest and targeted smoke checks`,
      mtimeMs: Date.parse("2026-03-02T00:00:00.000Z")
    });

    const descriptors: AgentDescriptor[] = [
      makeManagerDescriptor({
        agentId: "creator-session",
        sessionLabel: "Agent Creator",
        sessionPurpose: "agent_creator"
      }),
      makeManagerDescriptor({
        agentId: "backend-specialist--s2",
        sessionLabel: "Backend Specialist",
        projectAgent: {
          handle: "backend-specialist",
          whenToUse: "Use for backend correctness and route debugging.",
          systemPrompt: "Backend specialist focused on APIs.\n\nValidate behavior with targeted tests."
        }
      })
    ];

    const context = await gatherAgentCreatorContext(dataDir, profileId, descriptors, "creator-session");

    expect(context.existingAgents).toHaveLength(1);
    expect(context.existingAgents[0]).toMatchObject({
      handle: "backend-specialist",
      displayName: "Backend Specialist",
      whenToUse: "Use for backend correctness and route debugging."
    });
    expect(context.existingAgents[0]?.systemPromptExcerpt).toBe("Backend specialist focused on APIs.");
    expect(context.sessionMemories).toHaveLength(1);
    expect(context.sessionMemories[0]).toMatchObject({
      sessionId: "qa-session",
      label: "QA Session"
    });
    expect(context.sessionMemories[0]?.excerpt).toContain("Validate fixes with vitest and targeted smoke checks");
  });
});
