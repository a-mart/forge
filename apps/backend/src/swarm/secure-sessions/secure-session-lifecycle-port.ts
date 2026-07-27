import type { SecureSessionLifecyclePort } from "../session-lifecycle-coordinator.js";
import type { SecureOrphanRecoveryResult } from "./execution/secure-execution-backend.js";
import type { SecureSessionsService } from "./secure-sessions-service.js";

export interface SecureSessionCoordinatorPort extends SecureSessionLifecyclePort {
  initializeForBoot(): Promise<SecureOrphanRecoveryResult>;
  isTeamSecureMode(managerAgentId: string): boolean;
  prepareWorkerForSecureTeam(workerAgentId: string): Promise<boolean>;
  advanceWorkerSecureAssignment(
    workerAgentId: string,
    assignmentId: string,
  ): Promise<void>;
}

export type SecureWorkerLifecyclePort = Pick<
  SecureSessionCoordinatorPort,
  | "isTeamSecureMode"
  | "prepareWorkerForSecureTeam"
  | "advanceWorkerSecureAssignment"
>;

/**
 * Keeps Secure Sessions lifecycle authority behind the coordinator's narrow
 * port without making SwarmManager translate each operation inline.
 */
export function createSecureSessionLifecyclePort(
  service: SecureSessionsService,
): SecureSessionCoordinatorPort {
  return {
    initializeForBoot: () => service.initializeSecureSessions(),
    isTeamSecureMode: (managerAgentId) =>
      service.isTeamSecureMode(managerAgentId),
    prepareWorkerForSecureTeam: (workerAgentId) =>
      service.prepareWorkerForSecureTeam(workerAgentId),
    advanceWorkerSecureAssignment: (workerAgentId, assignmentId) =>
      service.advanceWorkerSecureAssignment(workerAgentId, assignmentId),
    beginLifecycleFence: (profileId, sessionAgentIds) =>
      service.beginSecureSessionLifecycleFence(profileId, sessionAgentIds),
    cancelLifecycleFence: (fenceId) =>
      service.cancelSecureSessionLifecycleFence(fenceId),
    completeLifecycleFence: (fenceId, outcome) =>
      service.completeSecureSessionLifecycleFence(fenceId, outcome),
    clearLifecycleFenceForRestore: (profileId, sessionAgentIds) =>
      service.clearSecureSessionLifecycleFenceForRestore(
        profileId,
        sessionAgentIds,
      ),
    prepareSessionForDeletion: (sessionAgentId) =>
      service.prepareSecureSessionForDeletion(sessionAgentId),
    deleteSessionStateAfterCoreDeletion: (sessionAgentId) =>
      service.deleteSecureSessionStateAfterCoreDeletion(sessionAgentId),
    stopForLifecycle: (agentId, options) =>
      service.stopSecureSessionForLifecycle(agentId, options),
    deleteProjectState: (profileId) =>
      service.deleteSecureSecretProjectState(profileId),
  };
}
