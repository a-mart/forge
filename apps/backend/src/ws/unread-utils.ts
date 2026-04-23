import type { SwarmManager } from "../swarm/swarm-manager.js";

export function resolveSessionAgentIdForUnread(
  swarmManager: Pick<SwarmManager, "getAgent">,
  agentId: string,
): string | undefined {
  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) {
    return undefined;
  }

  if (descriptor.role === "manager") {
    return descriptor.agentId;
  }

  const managerDescriptor = swarmManager.getAgent(descriptor.managerId);
  if (!managerDescriptor) {
    return undefined;
  }

  return descriptor.managerId;
}
