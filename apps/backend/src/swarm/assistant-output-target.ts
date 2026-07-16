import type {
  AssistantOutputTarget,
  SessionTranscriptAssistantOutputTarget,
} from "./types.js";

export function cloneSessionTranscriptAssistantOutputTarget(
  target: SessionTranscriptAssistantOutputTarget,
): SessionTranscriptAssistantOutputTarget {
  return {
    kind: "session_transcript",
    channel: target.channel,
    ...(target.sourceContext ? { sourceContext: { ...target.sourceContext } } : {}),
  };
}

export function cloneAssistantOutputTarget(target: AssistantOutputTarget): AssistantOutputTarget {
  switch (target.kind) {
    case "session_transcript":
      return cloneSessionTranscriptAssistantOutputTarget(target);
    case "external_channel":
      return { kind: "external_channel", sourceContext: { ...target.sourceContext } };
    case "peer_agent":
      return { kind: "peer_agent", fromAgentId: target.fromAgentId };
    case "explicit_tool_required":
      return { kind: "explicit_tool_required", reason: target.reason };
    case "internal_only":
      return { kind: "internal_only", ...(target.reason ? { reason: target.reason } : {}) };
  }
}
