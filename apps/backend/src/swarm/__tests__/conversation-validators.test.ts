import { describe, expect, it } from "vitest";
import { isConversationEntryEvent } from "../session/conversation-validators.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function makeWorkPlanCreated(overrides: Record<string, unknown> = {}) {
  return {
    type: "work_plan_created",
    agentId: "manager-1",
    id: "work-plan-created-1",
    timestamp: FIXED_NOW,
    planId: "plan-1",
    stateRevision: 1,
    planRevision: 2,
    plan: {
      planId: "plan-1",
      title: "Validated plan",
      goal: "Validate nested snapshot fields",
      mode: "standard",
      status: "active",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      revision: 2,
      items: [
        {
          itemId: "item-1",
          title: "Check nested item",
          phase: "Validation",
          status: "active",
          note: "Has details",
          blocker: { reason: "Needs review", needsUser: false },
          result: { summary: "Partial", status: "unknown" },
          workerLinks: [
            {
              type: "worker",
              linkId: "link-1",
              agentId: "worker-1",
              label: "Worker",
              specialistId: "backend",
              linkedAt: FIXED_NOW
            }
          ],
          workerLinkCount: 1,
          workerLinksTruncated: false
        }
      ],
      itemCount: 1,
      itemsTruncated: false,
      latestRevisionNote: { revision: 2, note: "Updated", createdAt: FIXED_NOW },
      warnings: ["Follow up"],
      warningCount: 1,
      warningsTruncated: false,
      finalSummary: "Initial receipt",
      lifecycle: { reason: "manual_stop", changedAt: FIXED_NOW }
    },
    ...overrides
  };
}

describe("conversation validators", () => {
  it("accepts CLI source context on persisted conversation messages", () => {
    expect(
      isConversationEntryEvent({
        type: "conversation_message",
        agentId: "manager-1",
        id: "message-1",
        role: "user",
        text: "from cli",
        timestamp: FIXED_NOW,
        source: "user_input",
        sourceContext: { channel: "cli", userId: "run-1" }
      })
    ).toBe(true);
  });

  it("accepts CLI source context on persisted agent message activity", () => {
    expect(
      isConversationEntryEvent({
        type: "agent_message",
        agentId: "manager-1",
        timestamp: FIXED_NOW,
        source: "user_to_agent",
        toAgentId: "manager-1",
        text: "from cli",
        sourceContext: { channel: "cli", messageId: "dispatch-1" }
      })
    ).toBe(true);
  });

  it("accepts a valid work_plan_created receipt with a nested Work Plan snapshot", () => {
    expect(isConversationEntryEvent(makeWorkPlanCreated())).toBe(true);
  });

  it("rejects malformed work_plan_created top-level identity and revision fields", () => {
    expect(isConversationEntryEvent(makeWorkPlanCreated({ id: "" }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ planId: "" }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ timestamp: 123 }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ stateRevision: -1 }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ planRevision: Number.NaN }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...(makeWorkPlanCreated().plan as Record<string, unknown>), planId: "other" } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...(makeWorkPlanCreated().plan as Record<string, unknown>), revision: 99 } }))).toBe(false);
  });

  it("rejects malformed nested Work Plan snapshots before replay", () => {
    const basePlan = makeWorkPlanCreated().plan as Record<string, unknown>;
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, status: "running" } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, itemsTruncated: "no" } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, warningCount: -1 } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, warningsTruncated: "false" } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, lifecycle: { reason: "timer", changedAt: FIXED_NOW } } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, latestRevisionNote: { revision: -1, note: "bad", createdAt: FIXED_NOW } } }))).toBe(false);
  });

  it("rejects malformed nested Work Plan item and worker-link snapshots", () => {
    const basePlan = makeWorkPlanCreated().plan as Record<string, unknown>;
    const [baseItem] = basePlan.items as Record<string, unknown>[];
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, status: "later" }] } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, workerLinkCount: Number.POSITIVE_INFINITY }] } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, workerLinksTruncated: "no" }] } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, blocker: { reason: "bad", needsUser: "yes" } }] } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, result: { summary: "bad", status: "partial-ish" } }] } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, workerLinks: [{ type: "worker", linkId: "", agentId: "worker", linkedAt: FIXED_NOW }] }] } }))).toBe(false);
    expect(isConversationEntryEvent(makeWorkPlanCreated({ plan: { ...basePlan, items: [{ ...baseItem, workerLinks: [{ type: "artifact", linkId: "link", agentId: "worker", linkedAt: FIXED_NOW }] }] } }))).toBe(false);
  });
});
