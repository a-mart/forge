import type { AgentDescriptor, AgentModelDescriptor, ManagerProfile } from "../../types.js";

function cloneContextUsage(descriptor: AgentDescriptor): AgentDescriptor["contextUsage"] {
  return descriptor.contextUsage
    ? {
        tokens: descriptor.contextUsage.tokens,
        contextWindow: descriptor.contextUsage.contextWindow,
        percent: descriptor.contextUsage.percent
      }
    : undefined;
}

function cloneCliSessionMetadata(descriptor: AgentDescriptor): AgentDescriptor["cli"] {
  return descriptor.cli
    ? {
        createdBy: descriptor.cli.createdBy,
        runId: descriptor.cli.runId,
        command: descriptor.cli.command,
        startedAt: descriptor.cli.startedAt,
        ...(descriptor.cli.invocationCwd !== undefined ? { invocationCwd: descriptor.cli.invocationCwd } : {}),
        ...(descriptor.cli.label !== undefined ? { label: descriptor.cli.label } : {})
      }
    : undefined;
}

function cloneProjectAgent(
  projectAgent: AgentDescriptor["projectAgent"],
  options: { includeSystemPrompt: boolean; includeSource: boolean }
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
    ...(projectAgent.capabilities !== undefined ? { capabilities: [...projectAgent.capabilities] } : {}),
    ...(options.includeSource && projectAgent.source !== undefined ? { source: { ...projectAgent.source } } : {})
  };
}

export function cloneDescriptorForPersistence(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: {
      provider: descriptor.model.provider,
      modelId: descriptor.model.modelId,
      thinkingLevel: descriptor.model.thinkingLevel
    },
    contextUsage: cloneContextUsage(descriptor),
    projectAgent: cloneProjectAgent(descriptor.projectAgent, { includeSystemPrompt: true, includeSource: true }),
    collab: descriptor.collab ? { ...descriptor.collab } : undefined,
    cli: cloneCliSessionMetadata(descriptor),
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
    projectAgent: cloneProjectAgent(descriptor.projectAgent, { includeSystemPrompt: false, includeSource: false })
  };
}

function cloneModelDescriptor(model: AgentModelDescriptor): AgentModelDescriptor {
  return {
    provider: model.provider,
    modelId: model.modelId,
    thinkingLevel: model.thinkingLevel
  };
}

export function cloneProfile(profile: ManagerProfile): ManagerProfile {
  return {
    ...profile,
    defaultModel: profile.defaultModel ? cloneModelDescriptor(profile.defaultModel) : profile.defaultModel
  };
}
