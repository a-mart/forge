import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertProjectAgentHandleMutationAllowed,
  buildProjectAgentInfoForMutation,
  normalizeProjectAgentHandleForMutation,
  normalizeProjectAgentWhenToUseForMutation,
  planProjectAgentReferenceWriteMutation,
  planSetSessionProjectAgentMutation
} from "../agents/project-agent-mutations.js";
import type { AgentDescriptor } from "../types.js";

function makeDescriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId">): AgentDescriptor & { role: "manager"; profileId: string } {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: "manager",
    managerId: overrides.managerId ?? overrides.agentId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: overrides.sessionFile ?? join("/tmp", `${overrides.agentId}.jsonl`),
    profileId: overrides.profileId ?? "profile-a",
    sessionLabel: overrides.sessionLabel,
    projectAgent: overrides.projectAgent
  };
}

describe("project-agent mutation helpers", () => {
  it("normalizes handles for mutation planning", () => {
    expect(normalizeProjectAgentHandleForMutation(" Docs Agent!! ")).toBe("docs-agent");
    expect(normalizeProjectAgentHandleForMutation("---")).toBe("");
  });

  it("rejects immutable handle updates", () => {
    expect(() =>
      assertProjectAgentHandleMutationAllowed({ handle: "docs", whenToUse: "Docs" }, "qa")
    ).toThrow("Cannot change project agent handle after promotion. Demote and re-promote to change the handle.");
    expect(() =>
      assertProjectAgentHandleMutationAllowed({ handle: "docs", whenToUse: "Docs" }, "docs")
    ).not.toThrow();
  });

  it("trims and validates when-to-use text", () => {
    expect(normalizeProjectAgentWhenToUseForMutation("  Use   for docs\nupdates  ")).toBe("Use for docs updates");
    expect(() => normalizeProjectAgentWhenToUseForMutation("   ")).toThrow(
      'Project agent "When to use" must be non-empty'
    );
    expect(() => normalizeProjectAgentWhenToUseForMutation("x".repeat(281))).toThrow(
      'Project agent "When to use" must be 280 characters or fewer'
    );
  });

  it("preserves descriptor fallback prompt when systemPrompt is omitted", () => {
    const descriptor = makeDescriptor({
      agentId: "docs",
      projectAgent: { handle: "docs", whenToUse: "Docs", systemPrompt: "Keep docs current" }
    });

    expect(
      buildProjectAgentInfoForMutation({ descriptor, whenToUse: "Docs updates", handle: "docs" }).systemPrompt
    ).toBe("Keep docs current");
  });

  it("preserves and normalizes capabilities", () => {
    const descriptor = makeDescriptor({
      agentId: "docs",
      projectAgent: { handle: "docs", whenToUse: "Docs", capabilities: ["create_session"] }
    });

    expect(buildProjectAgentInfoForMutation({ descriptor, whenToUse: "Docs", handle: "docs" }).capabilities).toEqual([
      "create_session"
    ]);
    expect(
      buildProjectAgentInfoForMutation({
        descriptor,
        whenToUse: "Docs",
        handle: "docs",
        capabilities: ["create_session", "create_session"]
      }).capabilities
    ).toEqual(["create_session"]);
  });

  it("builds config write plans", () => {
    const descriptor = makeDescriptor({ agentId: "docs" });
    const plan = planSetSessionProjectAgentMutation({
      descriptor,
      projectAgent: {
        handle: "Docs Agent",
        whenToUse: "  Docs   updates ",
        systemPrompt: " Write docs ",
        capabilities: ["create_session"]
      },
      updatedAt: "2026-04-03T00:00:00.000Z"
    });

    expect(plan.flags).toMatchObject({ directoryChanged: true, descriptorChanged: true, recordChanged: true });
    expect(plan.nextProjectAgent).toEqual({
      handle: "docs-agent",
      whenToUse: "Docs updates",
      systemPrompt: "Write docs",
      capabilities: ["create_session"]
    });
    expect(plan.configPlan).toEqual({
      kind: "write",
      profileId: "profile-a",
      handle: "docs-agent",
      config: {
        version: 1,
        agentId: "docs",
        handle: "docs-agent",
        whenToUse: "Docs updates",
        capabilities: ["create_session"],
        promotedAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-03T00:00:00.000Z"
      },
      systemPrompt: "Write docs"
    });
  });

  it("preserves source metadata when building project-agent info directly", () => {
    const source = {
      type: "repo" as const,
      workspaceKey: "profile-a::/repo",
      forgeDirRealpath: "/repo/.forge",
      definitionId: "docs",
      activatedAt: "2026-04-03T00:00:00.000Z"
    };
    const descriptor = makeDescriptor({
      agentId: "docs",
      projectAgent: { handle: "docs", whenToUse: "Docs", source }
    });

    expect(buildProjectAgentInfoForMutation({ descriptor, whenToUse: "Docs", handle: "docs" }).source).toEqual(source);
  });

  it("blocks repo-sourced edits but allows unlink without deleting local records", () => {
    const descriptor = makeDescriptor({
      agentId: "docs",
      projectAgent: {
        handle: "docs",
        whenToUse: "Docs",
        source: {
          type: "repo",
          workspaceKey: "profile-a::/repo",
          forgeDirRealpath: "/repo/.forge",
          definitionId: "docs",
          activatedAt: "2026-04-03T00:00:00.000Z"
        }
      }
    });

    expect(() =>
      planSetSessionProjectAgentMutation({
        descriptor,
        projectAgent: { whenToUse: "Updated docs" },
        updatedAt: "2026-04-04T00:00:00.000Z"
      })
    ).toThrow("Repository-managed project agents are read-only");
    expect(
      planSetSessionProjectAgentMutation({ descriptor, projectAgent: null, updatedAt: "2026-04-04T00:00:00.000Z" })
    ).toEqual({
      flags: {
        directoryChanged: true,
        promptChanged: false,
        referenceChanged: false,
        descriptorChanged: true,
        recordChanged: true
      },
      nextProjectAgent: null,
      configPlan: { kind: "none" }
    });
  });

  it("builds demote delete plans", () => {
    const descriptor = makeDescriptor({
      agentId: "docs",
      projectAgent: { handle: "docs", whenToUse: "Docs", systemPrompt: "Prompt" }
    });

    expect(
      planSetSessionProjectAgentMutation({ descriptor, projectAgent: null, updatedAt: "2026-04-03T00:00:00.000Z" })
    ).toEqual({
      flags: {
        directoryChanged: true,
        promptChanged: false,
        referenceChanged: false,
        descriptorChanged: true,
        recordChanged: true
      },
      nextProjectAgent: null,
      configPlan: { kind: "delete", profileId: "profile-a", handle: "docs" }
    });
  });

  it("reports reference write no-op after storage-compatible normalization and change results", () => {
    expect(
      planProjectAgentReferenceWriteMutation({ fileName: "notes.md", content: "same", existingContent: "same\n" })
    ).toEqual({
      flags: {
        directoryChanged: false,
        promptChanged: false,
        referenceChanged: false,
        descriptorChanged: false,
        recordChanged: false
      },
      changed: false,
      fileName: "notes.md",
      content: "same"
    });

    expect(
      planProjectAgentReferenceWriteMutation({ fileName: "notes.md", content: "next", existingContent: "old\n" })
        .flags.referenceChanged
    ).toBe(true);
  });
});
