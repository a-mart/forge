import type { AgentDescriptor } from "../swarm/types.js";

type LegacyWorkerSelfReportFields = {
  workerLastSelfReportAt?: string;
  workerLastSelfReportTurnSeq?: number;
};

export function toPublicCliAgentDescriptor(agent: AgentDescriptor): AgentDescriptor {
  const {
    sessionSystemPrompt: _sessionSystemPrompt,
    workerLastSelfReportAt: _workerLastSelfReportAt,
    workerLastSelfReportTurnSeq: _workerLastSelfReportTurnSeq,
    ...withoutPrompt
  } = agent as AgentDescriptor & LegacyWorkerSelfReportFields;
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
