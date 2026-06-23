import type { AssistantOutputTarget } from "./manager-assistant-output-tracker.js";

const ASSISTANT_OUTPUT_TARGET_METADATA_PATTERN = /^\[assistantOutputTarget\]\s+(\{[^\n]*\})(?:\n|$)/mu;

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
  }
}

export function runtimeInputAllowsProjectedAssistantOutput(text: string): boolean {
  const match = text.match(ASSISTANT_OUTPUT_TARGET_METADATA_PATTERN);
  if (!match) {
    return false;
  }

  try {
    const metadata = JSON.parse(match[1]) as { kind?: unknown };
    return metadata.kind === "session_transcript";
  } catch {
    return false;
  }
}
