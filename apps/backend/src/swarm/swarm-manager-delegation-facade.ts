import type { SwarmManagerFacadeServices } from "./swarm-manager-facade-services.js";
import type { SwarmConfigurationCoordinator } from "./swarm-configuration-coordinator.js";
import { SwarmManagerSecureSessionsFacade } from "./secure-sessions/swarm-manager-secure-sessions-facade.js";

/** Stateless public facade for manager posture and delegation-roster settings. */
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

  private get configuration() {
    return this.getFacadeServices().configuration;
  }
}
