import type { AgentDescriptor } from "../swarm/types.js";

export function toPublicCliAgentDescriptor(agent: AgentDescriptor): AgentDescriptor {
  const { sessionSystemPrompt: _sessionSystemPrompt, ...withoutPrompt } = agent;
  const publicProjectAgent = withoutPrompt.projectAgent
    ? {
        handle: withoutPrompt.projectAgent.handle,
        whenToUse: withoutPrompt.projectAgent.whenToUse,
        ...(withoutPrompt.projectAgent.creatorSessionId !== undefined
          ? { creatorSessionId: withoutPrompt.projectAgent.creatorSessionId }
          : {}),
        ...(withoutPrompt.projectAgent.capabilities !== undefined
          ? { capabilities: [...withoutPrompt.projectAgent.capabilities] }
          : {}),
      }
    : undefined;

  return {
    ...withoutPrompt,
    model: { ...withoutPrompt.model },
    ...(withoutPrompt.contextUsage !== undefined ? { contextUsage: { ...withoutPrompt.contextUsage } } : {}),
    ...(withoutPrompt.collab !== undefined ? { collab: { ...withoutPrompt.collab } } : {}),
    ...(withoutPrompt.cli !== undefined ? { cli: { ...withoutPrompt.cli } } : {}),
    projectAgent: publicProjectAgent,
  };
}
