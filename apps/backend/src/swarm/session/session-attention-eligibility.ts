import type { AgentDescriptor, ManagerProfile } from "@forge/protocol";

/**
 * The sole eligibility policy for server-owned session attention (Option C).
 * It is intentionally lifecycle/surface based, not a runtime-status filter:
 * a manually stopped, non-archived Builder session remains eligible for an
 * attention instance it already owns.
 */
export interface SessionAttentionEligibilityInput {
  manager: Pick<
    AgentDescriptor,
    | "agentId"
    | "managerId"
    | "role"
    | "profileId"
    | "sessionSurface"
    | "collab"
    | "sessionPurpose"
    | "archivedAt"
  >;
  profile: Pick<ManagerProfile, "profileId" | "profileType" | "archivedAt"> | undefined;
}

/** Explicit injection seam for the SessionAttentionCoordinator. */
export type SessionAttentionEligibilityPredicate = (
  input: SessionAttentionEligibilityInput,
) => boolean;

/**
 * Option C: active, non-archived Builder manager sessions only. Collaboration
 * and system automation are excluded; Project Agent sessions remain eligible.
 */
export const isSessionAttentionEligible: SessionAttentionEligibilityPredicate = ({
  manager,
  profile,
}) => {
  if (manager.role !== "manager" || manager.managerId !== manager.agentId) return false;
  if (!manager.profileId || !profile || profile.profileId !== manager.profileId) return false;
  if (manager.sessionSurface === "collab" || manager.collab) return false;
  if (manager.archivedAt || profile.archivedAt || profile.profileType === "system") return false;

  // All current non-user session purposes are system automation, including the
  // Agent Creator output session. Project Agent configuration is deliberately
  // not part of this check, so @documentation/@releases remain eligible.
  return manager.sessionPurpose === undefined;
};
