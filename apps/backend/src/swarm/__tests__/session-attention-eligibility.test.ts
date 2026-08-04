import { describe, expect, it } from "vitest";

import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";

import { isSessionAttentionEligible } from "../session/session-attention-eligibility.js";

const now = "2026-08-04T12:00:00.000Z";

function profile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: "project-1",
    displayName: "Project",
    defaultSessionAgentId: "session-1",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function manager(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: "session-1",
    managerId: "session-1",
    displayName: "Session",
    role: "manager",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    cwd: "/repo",
    model: { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "high" },
    sessionFile: "/repo/.forge/sessions/session-1.jsonl",
    profileId: "project-1",
    ...overrides,
  };
}

describe("session attention eligibility (Option C)", () => {
  it.each([
    ["ordinary Builder manager", manager(), profile(), true],
    ["manually stopped non-archived manager", manager({ status: "stopped" }), profile(), true],
    [
      "Project Agent manager",
      manager({ projectAgent: { handle: "documentation", whenToUse: "Maintain docs" } }),
      profile(),
      true,
    ],
    ["worker", manager({ role: "worker", managerId: "session-owner" }), profile(), false],
    ["non-owning manager descriptor", manager({ managerId: "session-owner" }), profile(), false],
    ["Collaboration manager", manager({ sessionSurface: "collab", collab: { workspaceId: "workspace-1", channelId: "channel-1" } }), profile(), false],
    ["system-automation profile", manager(), profile({ profileType: "system" }), false],
    ["Cortex review automation", manager({ sessionPurpose: "cortex_review" }), profile(), false],
    ["capture-check automation", manager({ sessionPurpose: "capture_check" }), profile(), false],
    ["Agent Creator output session", manager({ sessionPurpose: "agent_creator" }), profile(), false],
    ["directly archived session", manager({ archivedAt: now }), profile(), false],
    ["archived project", manager(), profile({ archivedAt: now }), false],
    ["missing project record", manager(), undefined, false],
    ["mismatched project record", manager(), profile({ profileId: "other-project" }), false],
  ] as const)("%s is %s", (_case, candidate, ownerProfile, expected) => {
    expect(isSessionAttentionEligible({ manager: candidate, profile: ownerProfile })).toBe(expected);
  });
});
