import type { AgentDescriptor, ManagerProfile } from "../../types.js";

function cloneContextUsage(descriptor: AgentDescriptor): AgentDescriptor["contextUsage"] {
  return descriptor.contextUsage
    ? {
        tokens: descriptor.contextUsage.tokens,
        contextWindow: descriptor.contextUsage.contextWindow,
        percent: descriptor.contextUsage.percent
      }
    : undefined;
}

function cloneProjectAgent(
  projectAgent: AgentDescriptor["projectAgent"],
  options: { includeSystemPrompt: boolean }
): AgentDescriptor["projectAgent"] {
  if (!projectAgent) {
    return undefined;
  }

  return {
    handle: projectAgent.handle,
    whenToUse: projectAgent.whenToUse,
    ...(options.includeSystemPrompt && projectAgent.systemPrompt !== undefined
      ? { systemPrompt: projectAgent.systemPrompt }
      : {}),
    ...(projectAgent.creatorSessionId !== undefined ? { creatorSessionId: projectAgent.creatorSessionId } : {}),
    ...(projectAgent.capabilities !== undefined ? { capabilities: [...projectAgent.capabilities] } : {})
  };
}

export function cloneDescriptorForPersistence(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    fastModePolicy: descriptor.fastModePolicy ? { ...descriptor.fastModePolicy } : undefined,
    contextUsage: cloneContextUsage(descriptor),
    projectAgent: cloneProjectAgent(descriptor.projectAgent, { includeSystemPrompt: true }),
    collab: descriptor.collab ? { ...descriptor.collab } : undefined,
    ...(descriptor.agentCreatorResult !== undefined
      ? {
          agentCreatorResult: {
            createdAgentId: descriptor.agentCreatorResult.createdAgentId,
            createdHandle: descriptor.agentCreatorResult.createdHandle,
            createdAt: descriptor.agentCreatorResult.createdAt
          }
        }
      : {})
  };
}

export function cloneDescriptorForPublic(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...cloneDescriptorForPersistence(descriptor),
    projectAgent: cloneProjectAgent(descriptor.projectAgent, { includeSystemPrompt: false })
  };
}

export function cloneProfile(profile: ManagerProfile): ManagerProfile {
  return {
    ...profile,
    defaultModel: profile.defaultModel ? { ...profile.defaultModel } : profile.defaultModel
  };
}
