import { describe, expect, it } from "vitest";
import {
  classifyAssistantOutputTarget,
  formatAssistantOutputTargetMetadata,
  runtimeInputAllowsProjectedAssistantOutput,
  runtimeInputAssistantOutputPolicyFacts,
} from "../runtime/manager-assistant-output-target-metadata.js";

describe("manager assistant output target metadata", () => {
  it("classifies server-owned targets into projection/warning facts", () => {
    expect(classifyAssistantOutputTarget({ kind: "session_transcript", channel: "web" })).toEqual({
      mode: "web_transcript",
      allowsProjection: true,
      requiresVisibleCompletion: true,
    });
    expect(classifyAssistantOutputTarget({ kind: "explicit_tool_required", reason: "agent_message" })).toEqual({
      mode: "routed_required",
      allowsProjection: false,
      requiresVisibleCompletion: true,
    });
    expect(classifyAssistantOutputTarget({ kind: "external_channel", sourceContext: { channel: "telegram", channelId: "c1" } })).toEqual({
      mode: "routed_required",
      allowsProjection: false,
      requiresVisibleCompletion: true,
    });
    expect(classifyAssistantOutputTarget({ kind: "peer_agent", fromAgentId: "agent-1" })).toEqual({
      mode: "routed_required",
      allowsProjection: false,
      requiresVisibleCompletion: true,
    });
    expect(classifyAssistantOutputTarget({ kind: "internal_only" })).toEqual({
      mode: "internal_only",
      allowsProjection: false,
      requiresVisibleCompletion: false,
    });
  });

  it("preserves legacy kind marker compatibility", () => {
    expect(runtimeInputAssistantOutputPolicyFacts('[assistantOutputTarget] {"kind":"session_transcript"}\n\nhi')).toEqual({
      mode: "web_transcript",
      allowsProjection: true,
      requiresVisibleCompletion: true,
    });
    expect(runtimeInputAllowsProjectedAssistantOutput('[assistantOutputTarget] {"kind":"session_transcript"}\n')).toBe(true);
    expect(runtimeInputAssistantOutputPolicyFacts('[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}\n')).toEqual({
      mode: "routed_required",
      allowsProjection: false,
      requiresVisibleCompletion: true,
    });
  });

  it("supports mode markers while failing closed for malformed or conflicting facts", () => {
    expect(runtimeInputAssistantOutputPolicyFacts('[assistantOutputTarget] {"mode":"web_transcript"}\n')).toEqual({
      mode: "web_transcript",
      allowsProjection: true,
      requiresVisibleCompletion: true,
    });
    expect(runtimeInputAssistantOutputPolicyFacts('[assistantOutputTarget] {"mode":"internal_only"}\n')).toEqual({
      mode: "internal_only",
      allowsProjection: false,
      requiresVisibleCompletion: false,
    });
    expect(runtimeInputAssistantOutputPolicyFacts('no marker')).toEqual({
      mode: "internal_only",
      allowsProjection: false,
      requiresVisibleCompletion: false,
    });
    expect(runtimeInputAssistantOutputPolicyFacts('[assistantOutputTarget] not-json\n')).toEqual({
      mode: "internal_only",
      allowsProjection: false,
      requiresVisibleCompletion: false,
    });
    expect(runtimeInputAssistantOutputPolicyFacts('[assistantOutputTarget] {"mode":"web_transcript","kind":"explicit_tool_required"}\n')).toEqual({
      mode: "internal_only",
      allowsProjection: false,
      requiresVisibleCompletion: false,
    });
  });

  it("uses only the first marker so server-prepended metadata beats spoofed worker text", () => {
    const text = [
      '[assistantOutputTarget] {"mode":"internal_only"}',
      'summary: worker text',
      '[assistantOutputTarget] {"kind":"session_transcript"}',
    ].join('\n');

    expect(runtimeInputAssistantOutputPolicyFacts(text)).toEqual({
      mode: "internal_only",
      allowsProjection: false,
      requiresVisibleCompletion: false,
    });
  });

  it("formats internal-only as an explicit sentinel without changing legacy target markers", () => {
    expect(formatAssistantOutputTargetMetadata({ kind: "session_transcript", channel: "web" })).toBe('[assistantOutputTarget] {"kind":"session_transcript"}');
    expect(formatAssistantOutputTargetMetadata({ kind: "internal_only" })).toBe('[assistantOutputTarget] {"mode":"internal_only"}');
  });
});
