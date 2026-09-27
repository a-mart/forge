import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { getProjectAgentPublicName } from "./agents/project-agent-registry.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

export interface SessionReferenceDependencies {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  profiles: ReadonlyMap<string, ManagerProfile>;
  saveStore(): Promise<void>;
}

/**
 * A user-created, persisted peer link between two manager sessions. Either side may
 * message the other through the peer (project-agent) delivery path.
 */
export function areSessionsReferenced(left: AgentDescriptor, right: AgentDescriptor): boolean {
  return (
    left.sessionReferenceAgentIds?.includes(right.agentId) === true ||
    right.sessionReferenceAgentIds?.includes(left.agentId) === true
  );
}

/**
 * Records the referenced sessions on the sender and returns model guidance naming them.
 * Ids that are not other live Builder manager sessions are ignored.
 */
export async function linkSessionReferences(
  deps: SessionReferenceDependencies,
  sender: AgentDescriptor,
  agentIds: readonly string[] | undefined,
): Promise<string | undefined> {
  if (!agentIds?.length || sender.role !== "manager") {
    return undefined;
  }

  const targets = [...new Set(agentIds)]
    .map((agentId) => deps.descriptors.get(agentId))
    .filter((target): target is AgentDescriptor =>
      target !== undefined &&
      target.agentId !== sender.agentId &&
      target.role === "manager" &&
      target.sessionSurface !== "collab" &&
      !target.archivedAt &&
      !isNonRunningAgentStatus(target.status),
    );
  if (targets.length === 0) {
    return undefined;
  }

  const previous = sender.sessionReferenceAgentIds;
  const next = [...new Set([...(previous ?? []), ...targets.map((target) => target.agentId)])];
  if (next.length !== previous?.length) {
    sender.sessionReferenceAgentIds = next;
    try {
      await deps.saveStore();
    } catch (error) {
      sender.sessionReferenceAgentIds = previous;
      throw error;
    }
  }

  const entries = targets.map((target) => {
    const profileId = target.profileId ?? target.agentId;
    return {
      agentId: target.agentId,
      name: getProjectAgentPublicName(target),
      project: deps.profiles.get(profileId)?.displayName ?? profileId,
    };
  });
  return `[sessionReferences] ${JSON.stringify(entries)}\nThe user referenced these manager sessions with [@name] tokens. They are peers: message one with send_message_to_agent using its agentId; it can reply to you.`;
}
