import type { SwarmManager } from "../swarm/swarm-manager.js";

export function resolveSessionAgentIdForUnread(
  swarmManager: Pick<SwarmManager, "getAgent">,
  agentId: string,
): string | undefined {
  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) {
    return undefined;
  }

  return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
}
