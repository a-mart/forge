import type {
  AgentDescriptor,
  AgentModelDescriptor,
  ExternalThreadInfo,
  ManagerProfile,
  WorkerParentContext,
} from "../../types.js";
import { cloneAssistantOutputTarget } from "../../assistant-output-target.js";

type LegacyWorkerSelfReportFields = {
  workerLastSelfReportAt?: string;
  workerLastSelfReportTurnSeq?: number;
};

function cloneContextUsage(descriptor: AgentDescriptor): AgentDescriptor["contextUsage"] {
  return descriptor.contextUsage
    ? {
        tokens: descriptor.contextUsage.tokens,
        contextWindow: descriptor.contextUsage.contextWindow,
        percent: descriptor.contextUsage.percent
      }
    : undefined;
}

export function cloneExternalThread(externalThread: ExternalThreadInfo): ExternalThreadInfo {
  return {
    type: externalThread.type,
    persisted: externalThread.persisted,
    createdByMention: externalThread.createdByMention,
    ...(externalThread.threadId !== undefined ? { threadId: externalThread.threadId } : {}),
    ...(externalThread.lastTurnId !== undefined ? { lastTurnId: externalThread.lastTurnId } : {})
  };
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

function cloneWorkerParentContext(context: WorkerParentContext | undefined): WorkerParentContext | undefined {
  return context
    ? {
        schemaVersion: 1,
        assignmentId: context.assignmentId,
        managerId: context.managerId,
        assignedAt: context.assignedAt,
        ...(context.completedAt ? { completedAt: context.completedAt } : {}),
        outputTarget: cloneAssistantOutputTarget(context.outputTarget),
        ...(context.rootTurnId ? { rootTurnId: context.rootTurnId } : {}),
        ...(context.parentRootTurnId ? { parentRootTurnId: context.parentRootTurnId } : {}),
      }
    : undefined;
}

export function cloneProjectAgent(
  projectAgent: AgentDescriptor["projectAgent"],
  options: { includeSystemPrompt: boolean; includeSource: boolean; includePublicSourceKind: boolean }
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
    ...(options.includePublicSourceKind && projectAgent.source?.type !== undefined
      ? { sourceKind: projectAgent.source.type }
      : {}),
    ...(options.includeSource && projectAgent.source !== undefined ? { source: { ...projectAgent.source } } : {})
  };
}

export function cloneDescriptorForPersistence(descriptor: AgentDescriptor): AgentDescriptor {
  const {
    workerLastSelfReportAt: _workerLastSelfReportAt,
    workerLastSelfReportTurnSeq: _workerLastSelfReportTurnSeq,
    ...descriptorWithoutLegacySelfReportMarker
  } = descriptor as AgentDescriptor & LegacyWorkerSelfReportFields;

  return {
    ...descriptorWithoutLegacySelfReportMarker,
    model: {
      provider: descriptor.model.provider,
      modelId: descriptor.model.modelId,
      thinkingLevel: descriptor.model.thinkingLevel
    },
    contextUsage: cloneContextUsage(descriptor),
    projectAgent: cloneProjectAgent(descriptor.projectAgent, {
      includeSystemPrompt: true,
      includeSource: true,
      includePublicSourceKind: false
    }),
    collab: descriptor.collab ? { ...descriptor.collab } : undefined,
    cli: cloneCliSessionMetadata(descriptor),
    externalThread: descriptor.externalThread ? cloneExternalThread(descriptor.externalThread) : undefined,
    workerParentContext: cloneWorkerParentContext(descriptor.workerParentContext),
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

export function cloneProjectAgentForPublic(projectAgent: AgentDescriptor["projectAgent"]): AgentDescriptor["projectAgent"] {
  return cloneProjectAgent(projectAgent, {
    includeSystemPrompt: false,
    includeSource: false,
    includePublicSourceKind: true
  });
}

export function cloneDescriptorForPublic(descriptor: AgentDescriptor): AgentDescriptor {
  const {
    sessionSystemPrompt: _sessionSystemPrompt,
    internalWorkerKind: _internalWorkerKind,
    workerParentContext: _workerParentContext,
    ...publicDescriptor
  } = cloneDescriptorForPersistence(descriptor);

  return {
    ...publicDescriptor,
    projectAgent: cloneProjectAgentForPublic(descriptor.projectAgent)
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
