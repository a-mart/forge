import { describe, expect, it } from "vitest";
import {
  MessageRouter,
  type MessageRouteProvenance,
  type MessageRouteReasonCode,
} from "../message-router.js";

const baseTurn: MessageRouteProvenance = {
  origin: "user",
  sourceContext: { channel: "web" },
  targetKind: "explicit_tool_required",
  role: "manager",
  senderRole: "manager",
  senderAgentId: "manager-1",
  targetAgentId: "manager-1",
  targetProfileId: "profile-1",
};

describe("MessageRouter", () => {
  it("implements the denylist and route matrix with stable reason codes", () => {
    const router = new MessageRouter();
    const cases: Array<{
      name: string;
      input: Partial<MessageRouteProvenance>;
      reasonCode: MessageRouteReasonCode;
      visible?: boolean;
      channel?: "web" | "telegram" | "cli" | "collab";
    }> = [
      {
        name: "D1 target is not a manager",
        input: { role: "worker" },
        reasonCode: "deny:target_not_manager",
      },
      {
        name: "D2 manager to project agent exchange",
        input: {
          senderAgentId: "manager-1",
          targetAgentId: "project-agent-1",
          targetProjectAgent: true,
        },
        reasonCode: "deny:project_agent_exchange",
      },
      {
        name: "D2 manager to child manager exchange",
        input: {
          senderAgentId: "manager-1",
          targetAgentId: "child-manager-1",
          targetCreatorAgentId: "manager-1",
        },
        reasonCode: "deny:project_agent_exchange",
      },
      {
        name: "D3 worker report into project manager",
        input: {
          senderRole: "worker",
          senderAgentId: "worker-1",
          targetProjectAgent: true,
        },
        reasonCode: "deny:project_agent_worker_report",
      },
      {
        name: "D3 worker report into child manager",
        input: {
          senderRole: "worker",
          senderAgentId: "worker-1",
          targetCreatorAgentId: "creator-1",
        },
        reasonCode: "deny:project_agent_worker_report",
      },
      {
        name: "D4 collab surface routes to collab",
        input: { targetSessionSurface: "collab" },
        reasonCode: "route:collab",
        channel: "collab",
      },
      {
        name: "D5 collaboration profile",
        input: { targetProfileId: "_collaboration" },
        reasonCode: "deny:collaboration_profile",
      },
      {
        name: "D6 cortex profile",
        input: { targetProfileId: "cortex" },
        reasonCode: "deny:cortex_profile",
      },
      {
        name: "D7 system profile",
        input: { targetProfileSystem: true },
        reasonCode: "deny:system_profile",
      },
      {
        name: "D8 cortex review purpose",
        input: { sessionPurpose: "cortex_review" },
        reasonCode: "deny:cortex_review",
      },
      {
        name: "D8 cortex archetype",
        input: { archetypeId: "Cortex" },
        reasonCode: "deny:cortex_review",
      },
      {
        name: "D8 collaboration channel archetype",
        input: { archetypeId: "collaboration channel" },
        reasonCode: "deny:collaboration_channel",
      },
      {
        name: "bootstrap self-send",
        input: { origin: "internal", internalDeliveryKind: "bootstrap" },
        reasonCode: "deny:bootstrap",
      },
      {
        name: "agent creator bootstrap only",
        input: {
          origin: "internal",
          internalDeliveryKind: "agent_creator_bootstrap",
          sessionPurpose: "agent_creator",
          archetypeId: "agent-architect",
        },
        reasonCode: "deny:agent_creator_bootstrap",
      },
      {
        name: "normal agent creator user turn remains visible",
        input: { sessionPurpose: "agent_creator", archetypeId: "agent-architect" },
        reasonCode: "render:user_web",
        visible: true,
        channel: "web",
      },
      {
        name: "worker health nudge routes by internal origin",
        input: { origin: "internal", internalDeliveryKind: "worker_health" },
        reasonCode: "route:internal_origin",
      },
      {
        name: "internal self-send routes internal by provenance",
        input: { origin: "internal" },
        reasonCode: "route:internal_origin",
      },
      {
        name: "codex operational guidance echo",
        input: { origin: "internal", internalDeliveryKind: "codex_plugin_bootstrap" },
        reasonCode: "deny:codex_operational_guidance",
      },
      {
        name: "peer agent target routes internally",
        input: { targetKind: "peer_agent" },
        reasonCode: "route:peer_agent",
      },
      {
        name: "telegram source routes to telegram",
        input: { sourceContext: { channel: "telegram", channelId: "t1" } },
        reasonCode: "route:telegram",
        channel: "telegram",
      },
      {
        name: "cli source routes to cli",
        input: { sourceContext: { channel: "cli" } },
        reasonCode: "route:cli",
        channel: "cli",
      },
      {
        name: "scheduled web source renders",
        input: { origin: "scheduled", sourceContext: { channel: "web" } },
        reasonCode: "render:scheduled_web",
        visible: true,
        channel: "web",
      },
      {
        name: "terminal worker report with explicit delivery stays routed",
        input: { origin: "terminal_worker_report", sourceContext: { channel: "web" } },
        reasonCode: "route:worker_report_all_view",
      },
      {
        name: "terminal worker report with a vetted transcript target renders",
        input: {
          origin: "terminal_worker_report",
          targetKind: "session_transcript",
          sourceContext: { channel: "web" },
        },
        reasonCode: "render:terminal_worker_report_closeout",
        visible: true,
        channel: "web",
      },
    ];

    for (const matrixCase of cases) {
      const decision = router.resolve({ ...baseTurn, ...matrixCase.input });
      expect(decision.reasonCode, matrixCase.name).toBe(matrixCase.reasonCode);
      expect(decision.visible, matrixCase.name).toBe(matrixCase.visible ?? false);
      if (matrixCase.channel) {
        expect(decision.channel, matrixCase.name).toBe(matrixCase.channel);
      }
    }
  });
});
