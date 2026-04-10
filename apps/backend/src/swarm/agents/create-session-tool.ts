import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";
import { spawnModelPresetSchema, spawnReasoningLevelSchema } from "../swarm-tools.js";

export function buildCreateSessionTool(
  host: SwarmToolHost,
  descriptor: AgentDescriptor
): ToolDefinition {
  return {
    name: "create_session",
    label: "Create Session",
    description:
      "Create a new manager session in the same profile. Omitted options inherit the profile defaults. Use this to spawn focused sub-sessions that you can then direct via send_message_to_agent.",
    parameters: Type.Object({
      sessionName: Type.String({
        minLength: 1,
        maxLength: 120,
        description: "Display label for the new manager session."
      }),
      cwd: Type.Optional(
        Type.String({ description: "Optional working directory override. Defaults to the profile cwd." })
      ),
      model: Type.Optional(spawnModelPresetSchema),
      reasoningLevel: Type.Optional(spawnReasoningLevelSchema),
      systemPrompt: Type.Optional(
        Type.String({
          description: "Optional system prompt override for the new session.",
          minLength: 1,
          maxLength: 4000
        })
      ),
      initialMessage: Type.Optional(
        Type.String({
          description: "Optional first message sent to the new session after creation.",
          minLength: 1,
          maxLength: 20000
        })
      )
    }),
    async execute(_toolCallId, params) {
      if (!host.createSessionFromAgent) {
        throw new Error("Session creation is not available in this runtime");
      }

      const parsed = params as {
        sessionName: string;
        cwd?: string;
        model?: string;
        reasoningLevel?: string;
        systemPrompt?: string;
        initialMessage?: string;
      };

      const result = await host.createSessionFromAgent(descriptor.agentId, {
        sessionName: parsed.sessionName,
        cwd: parsed.cwd,
        model: parsed.model,
        reasoningLevel: parsed.reasoningLevel,
        systemPrompt: parsed.systemPrompt,
        initialMessage: parsed.initialMessage
      });

      const message = `Session "${result.sessionLabel}" created successfully (agentId: ${result.sessionAgentId}). Use send_message_to_agent to direct it.`;

      return {
        content: [
          {
            type: "text",
            text: message
          }
        ],
        details: {
          sessionAgentId: result.sessionAgentId,
          sessionLabel: result.sessionLabel,
          profileId: result.profileId
        }
      };
    }
  };
}
