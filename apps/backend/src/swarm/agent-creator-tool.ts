import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import type { AgentDescriptor } from "./types.js";

export function buildCreateProjectAgentTool(
  host: SwarmToolHost,
  creatorDescriptor: AgentDescriptor
): ToolDefinition {
  return {
    name: "create_project_agent",
    label: "Create Project Agent",
    description:
      "Create a new project agent with the given configuration. Only call this after the user has explicitly approved the session name, handle (if customized), whenToUse directive, and system prompt.",
    parameters: Type.Object({
      sessionName: Type.String({
        minLength: 1,
        description: "Name for the new session."
      }),
      handle: Type.Optional(Type.String({
        minLength: 1,
        description: "Explicit handle for the project agent (for example, 'releases'). If omitted, it is derived from sessionName."
      })),
      whenToUse: Type.String({
        minLength: 1,
        maxLength: 280,
        description: "Routing guidance for sibling sessions (280 characters or fewer)."
      }),
      systemPrompt: Type.String({
        minLength: 1,
        description: "Complete base manager system prompt for the new project agent."
      })
    }),
    async execute(_toolCallId, params) {
      if (!host.createAndPromoteProjectAgent) {
        throw new Error("Project-agent creation is not available in this runtime");
      }

      const parsed = params as {
        sessionName: string;
        handle?: string;
        whenToUse: string;
        systemPrompt: string;
      };
      const result = await host.createAndPromoteProjectAgent(creatorDescriptor.agentId, parsed);
      const message = `Project agent @${result.handle} created successfully (agentId: ${result.agentId}).`;

      return {
        content: [
          {
            type: "text",
            text: message
          }
        ],
        details: {
          agentId: result.agentId,
          handle: result.handle,
          sessionName: parsed.sessionName
        }
      };
    }
  };
}
