export type AgentStatus = "idle" | "streaming" | "terminated" | "stopped" | "error";
export type AgentStatusInput = AgentStatus | "stopped_on_restart";

export const AGENT_STATUS_TRANSITIONS: Readonly<Record<AgentStatusInput, readonly AgentStatusInput[]>> = {
  idle: ["streaming", "terminated", "stopped"],
  streaming: ["idle", "terminated", "error"],
  terminated: ["idle"],
  stopped: ["idle", "terminated"],
  stopped_on_restart: ["idle", "terminated"],
  error: []
};

export function normalizeAgentStatus(status: AgentStatusInput): AgentStatus {
  return status === "stopped_on_restart" ? "stopped" : status;
}

export function transitionAgentStatus(current: AgentStatusInput, target: AgentStatusInput): AgentStatus {
  const normalizedCurrent = normalizeAgentStatus(current);
  const normalizedTarget = normalizeAgentStatus(target);

  if (normalizedCurrent === normalizedTarget) {
    return normalizedCurrent;
  }

  const allowedTargets = AGENT_STATUS_TRANSITIONS[current] ?? [];
  const canTransition = allowedTargets.some((candidate) => normalizeAgentStatus(candidate) === normalizedTarget);

  if (!canTransition) {
    throw new Error(`Invalid agent status transition: ${current} -> ${target}`);
  }

  return normalizedTarget;
}

export function isNonRunningAgentStatus(status: AgentStatusInput): boolean {
  const normalized = normalizeAgentStatus(status);
  return normalized === "terminated" || normalized === "stopped" || normalized === "error";
}
