import { isSystemProfile } from "@forge/protocol";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import {
  ARCHIVED_PROJECT_OPERATION_MESSAGE,
  ARCHIVED_SESSION_OPERATION_MESSAGE,
  isProfileArchived,
  isSessionDirectlyArchived,
} from "./archive/archive-resolver.js";
import { cloneDescriptorForPersistence, cloneProfile } from "./agents/descriptor-store/descriptor-clone.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import {
  assertBuilderSession,
  assertCollabSession,
  cloneDescriptor,
  normalizeAgentId,
  normalizeOptionalAgentId,
} from "./swarm-manager-utils.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";

export type ManagerSessionDescriptor = AgentDescriptor & {
  role: "manager";
  profileId: string;
};

export function isSessionAgentDescriptor(
  descriptor: AgentDescriptor | undefined,
): descriptor is ManagerSessionDescriptor {
  return !!descriptor && descriptor.role === "manager" &&
    typeof descriptor.profileId === "string" && descriptor.profileId.trim().length > 0;
}

export interface AgentDirectoryOptions {
  descriptors: ReadonlyMap<string, AgentDescriptor>;
  profiles: ReadonlyMap<string, ManagerProfile>;
  configuredManagerId?: string;
  getPendingChoiceCount(sessionAgentId: string): number;
}

interface WorkerVisibilityGroups {
  managers: AgentDescriptor[];
  workersByManagerId: Map<string, AgentDescriptor[]>;
}

export interface ProfileSortOrderAssignment {
  profileId: string;
  sortOrder: number;
}

/**
 * Read model for the live agent/profile registries.
 *
 * The directory owns lookup, ordering, public/internal cloning, visibility,
 * identity-allocation, and archive-read policy. It deliberately does not own
 * persistence or mutate either registry.
 */
export class AgentDirectory {
  private readonly configuredManagerId: string | undefined;

  constructor(private readonly options: AgentDirectoryOptions) {
    this.configuredManagerId = normalizeOptionalAgentId(options.configuredManagerId);
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
  }

  getConfiguredManagerId(): string | undefined {
    return this.configuredManagerId;
  }

  listAgentsForInternalUse(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptorForPersistence(descriptor));
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.options.descriptors.get(agentId);
    return descriptor ? cloneDescriptor(descriptor) : undefined;
  }

  getAgentForInternalUse(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.options.descriptors.get(agentId);
    return descriptor ? cloneDescriptorForPersistence(descriptor) : undefined;
  }

  listProfiles(): ManagerProfile[] {
    return this.sortedProfiles().map((profile) => cloneProfile(profile));
  }

  getProfile(profileId: string): ManagerProfile | undefined {
    const profile = this.options.profiles.get(profileId);
    return profile ? cloneProfile(profile) : undefined;
  }

  listUserProfiles(): ManagerProfile[] {
    return this.listProfiles().filter((profile) => !isSystemProfile(profile));
  }

  listBootstrapAgents(): AgentDescriptor[] {
    return this.listManagerAgents();
  }

  listManagerAgents(): AgentDescriptor[] {
    const grouped = this.buildWorkerVisibilityGroups();
    return grouped.managers.map((descriptor) =>
      this.cloneManagerDescriptorWithWorkerCounts(
        descriptor,
        grouped.workersByManagerId.get(descriptor.agentId) ?? [],
      ),
    );
  }

  listWorkersForSession(sessionAgentId: string): AgentDescriptor[] {
    const grouped = this.buildWorkerVisibilityGroups();
    return (grouped.workersByManagerId.get(sessionAgentId) ?? []).map((descriptor) =>
      cloneDescriptor(descriptor),
    );
  }

  sortedDescriptors(): AgentDescriptor[] {
    return Array.from(this.options.descriptors.values()).sort((left, right) => {
      if (this.configuredManagerId) {
        if (left.agentId === this.configuredManagerId) return -1;
        if (right.agentId === this.configuredManagerId) return 1;
      }

      if (left.role === "manager" && right.role !== "manager") return -1;
      if (right.role === "manager" && left.role !== "manager") return 1;

      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }

      return left.agentId.localeCompare(right.agentId);
    });
  }

  sortedProfiles(): ManagerProfile[] {
    return Array.from(this.options.profiles.values()).sort((left, right) => {
      if (this.configuredManagerId) {
        if (left.profileId === this.configuredManagerId) return -1;
        if (right.profileId === this.configuredManagerId) return 1;
      }

      const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }

      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }

      return left.profileId.localeCompare(right.profileId);
    });
  }

  materializeProfileSortOrder(): ProfileSortOrderAssignment[] | undefined {
    const requiresMaterialization = Array.from(this.options.profiles.values()).some(
      (profile) => profile.sortOrder === undefined || profile.sortOrder === null,
    );
    if (!requiresMaterialization) return undefined;

    return this.sortedProfiles().map((profile, sortOrder) => ({
      profileId: profile.profileId,
      sortOrder,
    }));
  }

  prepareProfileReorder(profileIds: readonly string[]): ProfileSortOrderAssignment[] {
    const currentProfiles = Array.from(this.options.profiles.values());
    const reorderableIds = new Set(
      currentProfiles
        .filter(
          (profile) =>
            profile.profileId !== CORTEX_PROFILE_ID &&
            !isSystemProfile(profile) &&
            !profile.archivedAt,
        )
        .map((profile) => profile.profileId),
    );

    const incomingIds = new Set(profileIds);
    if (incomingIds.size !== profileIds.length) {
      throw new Error("Duplicate profile IDs in reorder request");
    }
    if (incomingIds.size !== reorderableIds.size) {
      throw new Error(
        `Profile ID count mismatch: expected ${reorderableIds.size} but got ${incomingIds.size}`,
      );
    }
    for (const profileId of profileIds) {
      if (!reorderableIds.has(profileId)) {
        throw new Error(`Unknown or non-reorderable profile ID: ${profileId}`);
      }
    }

    const persistedOrderProfiles = [...currentProfiles].sort((left, right) => {
      const leftOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
      return left.profileId.localeCompare(right.profileId);
    });

    let nextReorderedIndex = 0;
    return persistedOrderProfiles.map((profile, sortOrder) => {
      const selectedProfile = reorderableIds.has(profile.profileId)
        ? this.options.profiles.get(profileIds[nextReorderedIndex++])
        : profile;
      return {
        profileId: selectedProfile?.profileId ?? profile.profileId,
        sortOrder,
      };
    });
  }

  getSessionsForProfile(profileId: string): ManagerSessionDescriptor[] {
    return Array.from(this.options.descriptors.values()).filter(
      (descriptor): descriptor is ManagerSessionDescriptor =>
        descriptor.role === "manager" && descriptor.profileId === profileId,
    );
  }

  getBuilderSessionsForProfile(profileId: string): ManagerSessionDescriptor[] {
    return this.getSessionsForProfile(profileId).filter(
      (descriptor) => descriptor.sessionSurface !== "collab",
    );
  }

  getWorkersForManager(managerId: string): AgentDescriptor[] {
    return this.buildWorkerVisibilityGroups().workersByManagerId.get(managerId) ?? [];
  }

  resolvePreferredManagerId(options?: {
    includeStoppedOnRestart?: boolean;
  }): string | undefined {
    const includeStoppedOnRestart = options?.includeStoppedOnRestart ?? false;
    if (this.configuredManagerId) {
      const configuredManager = this.options.descriptors.get(this.configuredManagerId);
      if (configuredManager && this.isAvailableManagerDescriptor(configuredManager, includeStoppedOnRestart)) {
        return this.configuredManagerId;
      }
    }

    const firstManager = Array.from(this.options.descriptors.values())
      .filter((descriptor) => this.isAvailableManagerDescriptor(descriptor, includeStoppedOnRestart))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.agentId.localeCompare(right.agentId);
      })[0];

    return firstManager?.agentId;
  }

  isSessionAgent(descriptor: AgentDescriptor | undefined): descriptor is ManagerSessionDescriptor {
    return isSessionAgentDescriptor(descriptor);
  }

  getRequiredSessionDescriptor(agentId: string): ManagerSessionDescriptor {
    const descriptor = this.options.descriptors.get(agentId);
    if (!this.isSessionAgent(descriptor)) {
      throw new Error(`Unknown session agent: ${agentId}`);
    }
    return descriptor;
  }

  getRequiredBuilderSessionDescriptor(agentId: string, action: string): ManagerSessionDescriptor {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    assertBuilderSession(descriptor, action);
    return descriptor;
  }

  getRequiredCollaborationSessionDescriptor(agentId: string, action: string): ManagerSessionDescriptor {
    const descriptor = this.getRequiredSessionDescriptor(agentId);
    assertCollabSession(descriptor, action);
    return descriptor;
  }

  getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.options.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }
    return descriptor;
  }

  getRequiredBuilderManagerDescriptor(managerId: string, action: string): AgentDescriptor {
    const descriptor = this.getRequiredManagerDescriptor(managerId);
    assertBuilderSession(descriptor, action);
    return descriptor;
  }

  assertSessionSupportsProjectAgent(descriptor: ManagerSessionDescriptor): void {
    assertBuilderSession(descriptor, "promote Builder sessions to project agents");

    if (descriptor.agentId === CORTEX_PROFILE_ID && descriptor.profileId === CORTEX_PROFILE_ID) {
      throw new Error("Cortex root cannot be promoted to a project agent");
    }
    if (descriptor.sessionPurpose === "cortex_review") {
      throw new Error("Cortex review sessions cannot be promoted to project agents");
    }
    if (descriptor.sessionPurpose === "agent_creator") {
      throw new Error("Agent creator sessions cannot be promoted to project agents");
    }
  }

  assertSessionIsDeletable(descriptor: AgentDescriptor): void {
    const profileId = descriptor.profileId ?? descriptor.agentId;
    const profile = this.options.profiles.get(profileId);
    const defaultSessionAgentId = profile?.defaultSessionAgentId ?? profileId;
    if (descriptor.agentId === defaultSessionAgentId) {
      throw new Error(`Cannot delete default session: ${descriptor.agentId}`);
    }
  }

  isAgentEffectivelyArchived(agentId: string): boolean {
    const descriptor = this.options.descriptors.get(agentId);
    return descriptor ? this.isDescriptorEffectivelyArchived(descriptor) : false;
  }

  assertProfileNotArchived(profileId: string): void {
    if (isProfileArchived(this.options.profiles.get(profileId))) {
      throw new Error(ARCHIVED_PROJECT_OPERATION_MESSAGE);
    }
  }

  assertManagerSettingsTargetNotArchived(managerId: string, operation: string): void {
    if (this.options.profiles.has(managerId)) {
      this.assertProfileNotArchived(managerId);
      return;
    }

    const descriptor = this.getRequiredBuilderSessionDescriptor(managerId, operation);
    this.assertDescriptorNotEffectivelyArchived(descriptor);
  }

  assertDescriptorNotEffectivelyArchived(descriptor: AgentDescriptor): void {
    const archivedReason = this.getDescriptorArchiveBlockReason(descriptor);
    if (archivedReason) {
      throw new Error(archivedReason);
    }
  }

  isDescriptorEffectivelyArchived(descriptor: AgentDescriptor): boolean {
    return this.getDescriptorArchiveBlockReason(descriptor) !== undefined;
  }

  getDescriptorArchiveBlockReason(descriptor: AgentDescriptor): string | undefined {
    if (descriptor.role !== "manager") {
      const owner = this.options.descriptors.get(descriptor.managerId);
      return owner ? this.getDescriptorArchiveBlockReason(owner) : undefined;
    }

    const profileId = descriptor.profileId ?? descriptor.managerId;
    if (isProfileArchived(this.options.profiles.get(profileId))) {
      return ARCHIVED_PROJECT_OPERATION_MESSAGE;
    }
    if (isSessionDirectlyArchived(descriptor)) {
      return ARCHIVED_SESSION_OPERATION_MESSAGE;
    }
    return undefined;
  }

  generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }
    if (this.configuredManagerId && base === this.configuredManagerId) {
      throw new Error(`spawn_agent agentId \"${this.configuredManagerId}\" is reserved`);
    }
    return this.generateUniqueId(base);
  }

  generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }
    return this.generateUniqueId(base);
  }

  assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }
    if (isNonRunningAgentStatus(descriptor.status)) {
      throw new Error(`Manager is not running: ${agentId}`);
    }
    return descriptor;
  }

  hasRunningManagers(options?: { excludeCortex?: boolean }): boolean {
    for (const descriptor of this.options.descriptors.values()) {
      if (descriptor.role !== "manager") continue;
      if (
        options?.excludeCortex &&
        normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID
      ) {
        continue;
      }
      if (!isNonRunningAgentStatus(descriptor.status)) return true;
    }
    return false;
  }

  private buildWorkerVisibilityGroups(): WorkerVisibilityGroups {
    const managers: AgentDescriptor[] = [];
    const workersByManagerId = new Map<string, AgentDescriptor[]>();

    for (const descriptor of this.sortedDescriptors()) {
      if (descriptor.role === "manager") {
        if (descriptor.sessionSurface !== "collab") managers.push(descriptor);
        continue;
      }

      const workers = workersByManagerId.get(descriptor.managerId);
      if (workers) workers.push(descriptor);
      else workersByManagerId.set(descriptor.managerId, [descriptor]);
    }

    return { managers, workersByManagerId };
  }

  private cloneManagerDescriptorWithWorkerCounts(
    descriptor: AgentDescriptor,
    workers: AgentDescriptor[],
  ): AgentDescriptor {
    const clone = cloneDescriptor(descriptor);
    clone.workerCount = workers.length;
    clone.activeWorkerCount = workers.filter((worker) => worker.status === "streaming").length;
    clone.pendingChoiceCount = this.options.getPendingChoiceCount(clone.agentId);
    return clone;
  }

  private isAvailableManagerDescriptor(
    descriptor: AgentDescriptor,
    includeStoppedOnRestart: boolean,
  ): boolean {
    if (descriptor.role !== "manager") return false;
    if (this.isDescriptorEffectivelyArchived(descriptor)) return false;
    if (descriptor.status === "terminated" || descriptor.status === "error") return false;
    return includeStoppedOnRestart || descriptor.status !== "stopped";
  }

  private generateUniqueId(base: string): string {
    if (!this.options.descriptors.has(base)) return base;

    let index = 2;
    while (this.options.descriptors.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }
}
