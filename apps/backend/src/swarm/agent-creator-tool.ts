import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { SwarmToolHost } from "./swarm-tools.js";
import type { AgentDescriptor } from "./types.js";

export function buildCreateProjectAgentTool(
  host: SwarmToolHost,
  creatorDescriptor: AgentDescriptor
): ToolDefinition {
  return {
    name: "create_project_agent",
    label: "Create Project Agent",
    description:
      "Create a new project agent with the given configuration. Only call this after the user has explicitly approved the session name, whenToUse directive, and system prompt.",
    parameters: Type.Object({
      sessionName: Type.String({
        description: "Name for the new session. This is also slugified into the project-agent handle."
      }),
      whenToUse: Type.String({
        description: "Routing guidance for sibling sessions (280 characters or fewer)."
      }),
      systemPrompt: Type.String({
        description: "Complete base manager system prompt for the new project agent."
      })
    }),
    async execute(_toolCallId, params) {
      if (!host.createAndPromoteProjectAgent) {
        throw new Error("Project-agent creation is not available in this runtime");
      }

      const parsed = params as {
        sessionName: string;
        whenToUse: string;
        systemPrompt: string;
      };
      const result = await host.createAndPromoteProjectAgent(creatorDescriptor.agentId, parsed);
      const message = `Project agent \"${parsed.sessionName}\" created successfully with handle @${result.handle} (agentId: ${result.agentId}).`;

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
