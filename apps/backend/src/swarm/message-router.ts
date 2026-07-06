import type { MessageSourceContext } from "./types.js";

export type MessageRouteOrigin = "user" | "internal" | "scheduled" | "terminal_worker_report";

export type MessageRouteInternalDeliveryKind =
  | "bootstrap"
  | "agent_creator_bootstrap"
  | "codex_plugin_bootstrap"
  | "worker_health";

export type MessageRouteTargetKind =
  | "session_transcript"
  | "explicit_tool_required"
  | "peer_agent"
  | "external_channel"
  | "internal_only";

export type MessageRouteRole = "manager" | "worker";

export type MessageRouteReasonCode =
  | "render:user_web"
  | "render:scheduled_web"
  | "render:terminal_worker_report_closeout"
  | "route:telegram"
  | "route:cli"
  | "route:collab"
  | "route:external_channel"
  | "route:peer_agent"
  | "route:worker_report_all_view"
  | "route:internal_origin"
  | "deny:target_not_manager"
  | "deny:project_agent_exchange"
  | "deny:project_agent_worker_report"
  | "deny:collaboration_profile"
  | "deny:cortex_profile"
  | "deny:system_profile"
  | "deny:cortex_review"
  | "deny:collaboration_channel"
  | "deny:bootstrap"
  | "deny:agent_creator_bootstrap"
  | "deny:codex_operational_guidance"
  | "deny:internal_only";

export interface MessageRouteProvenance {
  origin: MessageRouteOrigin;
  internalDeliveryKind?: MessageRouteInternalDeliveryKind;
  sourceContext?: MessageSourceContext;
  sessionPurpose?: "cortex_review" | "agent_creator" | "capture_check";
  archetypeId?: string;
  targetKind: MessageRouteTargetKind;
  role: MessageRouteRole;
  senderRole?: MessageRouteRole;
  senderAgentId?: string;
  targetAgentId?: string;
  targetProfileId?: string;
  targetSessionSurface?: "builder" | "collab";
  targetCollab?: boolean;
  targetProjectAgent?: boolean;
  targetCreatorAgentId?: string;
  targetProfileSystem?: boolean;
  projectAgentContext?: unknown;
}

export interface MessageRouteDecision {
  visible: boolean;
  decision: "render" | "route" | "drop";
  channel?: "web" | "telegram" | "cli" | "collab";
  reasonCode: MessageRouteReasonCode;
  targetKind: MessageRouteTargetKind;
}

const CORTEX_PROFILE_ID = "cortex";
const COLLABORATION_PROFILE_ID = "_collaboration";
const CORTEX_ARCHETYPE_ID = "cortex";
const COLLABORATION_CHANNEL_ARCHETYPE_ID = "collaboration-channel";

export class MessageRouter {
  resolve(input: MessageRouteProvenance): MessageRouteDecision {
    const targetKind = input.targetKind;

    if (input.role !== "manager") {
      return drop(targetKind, "deny:target_not_manager");
    }

    if (
      input.senderRole === "manager" &&
      input.senderAgentId !== undefined &&
      input.targetAgentId !== undefined &&
      input.senderAgentId !== input.targetAgentId &&
      (input.targetProjectAgent || input.targetCreatorAgentId === input.senderAgentId)
    ) {
      return drop(targetKind, "deny:project_agent_exchange");
    }

    if (input.senderRole === "worker" && (input.targetProjectAgent || input.targetCreatorAgentId !== undefined)) {
      return drop(targetKind, "deny:project_agent_worker_report");
    }

    if (input.targetSessionSurface === "collab" || input.targetCollab) {
      return route(targetKind, "route:collab", "collab");
    }

    if (input.targetAgentId === COLLABORATION_PROFILE_ID || input.targetProfileId === COLLABORATION_PROFILE_ID) {
      return drop(targetKind, "deny:collaboration_profile");
    }

    if (input.targetAgentId === CORTEX_PROFILE_ID || input.targetProfileId === CORTEX_PROFILE_ID) {
      return drop(targetKind, "deny:cortex_profile");
    }

    if (input.targetProfileSystem) {
      return drop(targetKind, "deny:system_profile");
    }

    const archetypeId = normalizeArchetypeId(input.archetypeId ?? "");
    if (input.sessionPurpose === "cortex_review" || archetypeId === CORTEX_ARCHETYPE_ID) {
      return drop(targetKind, "deny:cortex_review");
    }

    if (archetypeId === COLLABORATION_CHANNEL_ARCHETYPE_ID) {
      return drop(targetKind, "deny:collaboration_channel");
    }

    if (input.internalDeliveryKind === "bootstrap") {
      return drop(targetKind, "deny:bootstrap");
    }

    if (input.internalDeliveryKind === "agent_creator_bootstrap") {
      return drop(targetKind, "deny:agent_creator_bootstrap");
    }

    if (input.internalDeliveryKind === "codex_plugin_bootstrap") {
      return drop(targetKind, "deny:codex_operational_guidance");
    }

    if (targetKind === "peer_agent") {
      return route(targetKind, "route:peer_agent");
    }

    if (targetKind === "external_channel") {
      const channel = input.sourceContext?.channel;
      return route(targetKind, channel === "telegram" ? "route:telegram" : "route:external_channel", channel);
    }

    const channel = input.sourceContext?.channel;
    if (channel === "telegram") {
      return route(targetKind, "route:telegram", "telegram");
    }

    if (channel === "cli") {
      return route(targetKind, "route:cli", "cli");
    }

    if (input.origin === "internal") {
      return route(targetKind, "route:internal_origin");
    }

    if (targetKind === "internal_only") {
      return drop(targetKind, "deny:internal_only");
    }

    if (input.origin === "scheduled") {
      return render(targetKind, "render:scheduled_web");
    }

    if (input.origin === "terminal_worker_report") {
      return render(targetKind, "render:terminal_worker_report_closeout");
    }

    return render(targetKind, "render:user_web");
  }
}

function render(targetKind: MessageRouteTargetKind, reasonCode: MessageRouteReasonCode): MessageRouteDecision {
  return {
    visible: true,
    decision: "render",
    channel: "web",
    reasonCode,
    targetKind,
  };
}

function route(
  targetKind: MessageRouteTargetKind,
  reasonCode: MessageRouteReasonCode,
  channel?: MessageRouteDecision["channel"],
): MessageRouteDecision {
  return {
    visible: false,
    decision: "route",
    ...(channel ? { channel } : {}),
    reasonCode,
    targetKind,
  };
}

function drop(targetKind: MessageRouteTargetKind, reasonCode: MessageRouteReasonCode): MessageRouteDecision {
  return {
    visible: false,
    decision: "drop",
    reasonCode,
    targetKind,
  };
}

function normalizeArchetypeId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
