import type { SwarmManager } from "../../swarm/swarm-manager.js";

export function resolveCwdFromAgent(swarmManager: SwarmManager, agentId: string): string {
  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${agentId}`);
  }

  const effectiveDescriptor = descriptor.profileId
    ? swarmManager.getAgent(descriptor.profileId) ?? descriptor
    : descriptor;

  if (!effectiveDescriptor.cwd || effectiveDescriptor.cwd.trim().length === 0) {
    throw new Error("No CWD configured for this agent");
  }

  return effectiveDescriptor.cwd;
}
