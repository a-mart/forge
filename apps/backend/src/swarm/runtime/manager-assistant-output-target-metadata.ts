import type { AssistantOutputTarget } from "./manager-assistant-output-tracker.js";

const ASSISTANT_OUTPUT_TARGET_METADATA_PATTERN = /^\[assistantOutputTarget\]\s+(\{[^\n]*\})(?:\n|$)/mu;

export type AssistantOutputPolicyMode = "web_transcript" | "routed_required" | "internal_only";

export interface AssistantOutputPolicyFacts {
  mode: AssistantOutputPolicyMode;
  allowsProjection: boolean;
  requiresVisibleCompletion: boolean;
}

export function formatAssistantOutputTargetMetadata(target: AssistantOutputTarget): string {
  switch (target.kind) {
    case "session_transcript":
      return `[assistantOutputTarget] ${JSON.stringify({ kind: target.kind })}`;
    case "external_channel":
      return `[assistantOutputTarget] ${JSON.stringify({ kind: target.kind })}`;
    case "peer_agent":
      return `[assistantOutputTarget] ${JSON.stringify({ kind: target.kind })}`;
    case "explicit_tool_required":
      return `[assistantOutputTarget] ${JSON.stringify({ kind: target.kind, reason: target.reason })}`;
    case "internal_only":
      return `[assistantOutputTarget] ${JSON.stringify({ mode: "internal_only" })}`;
  }
}

export function classifyAssistantOutputTarget(target: AssistantOutputTarget | undefined): AssistantOutputPolicyFacts {
  if (!target) {
    return factsForMode("internal_only");
  }

  switch (target.kind) {
    case "session_transcript":
      return factsForMode("web_transcript");
    case "external_channel":
    case "peer_agent":
    case "explicit_tool_required":
      return factsForMode("routed_required");
    case "internal_only":
      return factsForMode("internal_only");
  }
}

export function runtimeInputAssistantOutputPolicyFacts(text: string): AssistantOutputPolicyFacts {
  const match = text.match(ASSISTANT_OUTPUT_TARGET_METADATA_PATTERN);
  if (!match) {
    return factsForMode("internal_only");
  }

  try {
    const metadata = JSON.parse(match[1]) as { mode?: unknown; kind?: unknown };
    const modeFromMetadata = parsePolicyMode(metadata.mode);
    const modeFromKind = parseLegacyKindMode(metadata.kind);

    if (metadata.mode !== undefined) {
      if (!modeFromMetadata) {
        return factsForMode("internal_only");
      }
      if (metadata.kind !== undefined && modeFromKind !== modeFromMetadata) {
        return factsForMode("internal_only");
      }
      return factsForMode(modeFromMetadata);
    }

    return factsForMode(modeFromKind ?? "internal_only");
  } catch {
    return factsForMode("internal_only");
  }
}

export function runtimeInputAllowsProjectedAssistantOutput(text: string): boolean {
  return runtimeInputAssistantOutputPolicyFacts(text).allowsProjection;
}

function parsePolicyMode(value: unknown): AssistantOutputPolicyMode | undefined {
  switch (value) {
    case "web_transcript":
    case "routed_required":
    case "internal_only":
      return value;
    default:
      return undefined;
  }
}

function parseLegacyKindMode(value: unknown): AssistantOutputPolicyMode | undefined {
  switch (value) {
    case "session_transcript":
      return "web_transcript";
    case "external_channel":
    case "peer_agent":
    case "explicit_tool_required":
      return "routed_required";
    case "internal_only":
      return "internal_only";
    default:
      return undefined;
  }
}

function factsForMode(mode: AssistantOutputPolicyMode): AssistantOutputPolicyFacts {
  switch (mode) {
    case "web_transcript":
      return { mode, allowsProjection: true, requiresVisibleCompletion: true };
    case "routed_required":
      return { mode, allowsProjection: false, requiresVisibleCompletion: true };
    case "internal_only":
      return { mode, allowsProjection: false, requiresVisibleCompletion: false };
  }
}
