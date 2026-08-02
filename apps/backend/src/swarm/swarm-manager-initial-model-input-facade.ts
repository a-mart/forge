import type { AgentInitialModelInputState } from "@forge/protocol";
import { SwarmManagerDelegationFacade } from "./swarm-manager-delegation-facade.js";
import { readInitialModelInputForViewer } from "./runtime/initial-model-input-viewer.js";

/** Stable public facade for the Pi initial model-input viewer. */
export abstract class SwarmManagerInitialModelInputFacade extends SwarmManagerDelegationFacade {
  getAgentInitialModelInputForRead(agentId: string): AgentInitialModelInputState {
    const services = this.getFacadeServices();
    return readInitialModelInputForViewer(
      services.registry.directory.getAgent(agentId),
      services.runtime.runtimes.get(agentId),
    );
  }
}
