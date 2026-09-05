import {
  DEFAULT_CONTEXT_MODE,
  type ContextMode,
  type SessionContextModeSnapshot,
} from "@forge/protocol";
import {
  CONTEXT_MODE_WORKER_WRITE_ERROR,
  buildSessionContextModeSnapshot,
  resolveOwningManagerId,
} from "./context-mode.js";
import type { SwarmManagerFacadeServices } from "./swarm-manager-facade-services.js";
import type { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import { SwarmManagerSecureSessionsFacade } from "./secure-sessions/swarm-manager-secure-sessions-facade.js";
import type { AgentDescriptor, ManagerProfile } from "./types.js";

/** Stateless public facade for manager posture, delegation-roster, and context-mode settings. */
export abstract class SwarmManagerDelegationFacade extends SwarmManagerSecureSessionsFacade {
  protected abstract getFacadeServices(): SwarmManagerFacadeServices;

  updateProjectDelegationDefaults(
    profileId: string,
    updates: Parameters<SwarmConfigurationCoordinator["updateProjectDelegationDefaults"]>[1],
  ): Promise<void> {
    return this.configuration.updateProjectDelegationDefaults(profileId, updates);
  }

  getDelegationRosterSettings() {
    return this.configuration.getDelegationRosterSettings();
  }

  saveDelegationRosterSettings(input: unknown) {
    return this.configuration.saveDelegationRosterSettings(input);
  }

  updateSessionDelegation(
    sessionAgentId: string,
    updates: Parameters<SwarmConfigurationCoordinator["updateSessionDelegation"]>[1],
  ): Promise<void> {
    return this.configuration.updateSessionDelegation(sessionAgentId, updates);
  }

  getProjectContextMode(profileId: string): { profileId: string; mode: ContextMode } {
    const profile = this.requireProfile(profileId);
    return {
      profileId: profile.profileId,
      mode: profile.defaultContextMode ?? DEFAULT_CONTEXT_MODE,
    };
  }

  updateProjectContextMode(
    profileId: string,
    mode: ContextMode,
  ): Promise<ManagerProfile> {
    return this.configuration.updateProjectContextMode(profileId, mode);
  }

  getSessionContextMode(agentId: string): SessionContextModeSnapshot {
    const services = this.getFacadeServices();
    const caller = services.registry.directory.getAgentForInternalUse(agentId)
      ?? services.registry.directory.getAgent(agentId);
    if (!caller) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const managerId = resolveOwningManagerId(caller);
    const manager = caller.role === "manager"
      ? caller
      : services.registry.directory.getAgentForInternalUse(managerId)
        ?? services.registry.directory.getAgent(managerId);
    if (!manager || manager.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }
    const profileId = manager.profileId ?? manager.agentId;
    const profile = this.requireProfile(profileId);
    return buildSessionContextModeSnapshot({
      sessionAgentId: manager.agentId,
      profile,
      manager,
      runtime: services.runtime.runtimes.get(manager.agentId),
    });
  }

  getContextMode(callerAgentId: string): ContextMode {
    return this.getSessionContextMode(callerAgentId).effectiveMode;
  }

  async updateSessionContextMode(
    sessionAgentId: string,
    mode: ContextMode | null,
  ): Promise<AgentDescriptor> {
    const services = this.getFacadeServices();
    const caller = services.registry.directory.getAgentForInternalUse(sessionAgentId)
      ?? services.registry.directory.getAgent(sessionAgentId);
    if (!caller) {
      throw new Error(`Unknown agent: ${sessionAgentId}`);
    }
    if (caller.role !== "manager") {
      throw new Error(CONTEXT_MODE_WORKER_WRITE_ERROR);
    }
    const snapshot = this.getSessionContextMode(sessionAgentId);
    if (mode === "fresh" && !snapshot.freshSupported) {
      throw new Error(
        snapshot.unsupportedReason ?? "Fresh windows are not supported for this session runtime.",
      );
    }
    return this.configuration.updateSessionContextMode(sessionAgentId, mode);
  }

  private requireProfile(profileId: string): ManagerProfile {
    const profile = this.getFacadeServices().registry.directory.getProfile(profileId);
    if (!profile) {
      throw new Error(`Unknown manager profile: ${profileId}`);
    }
    return profile;
  }

  private get configuration() {
    return this.getFacadeServices().configuration;
  }
}
