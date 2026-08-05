import { SwarmManagerInitialModelInputFacade } from "./swarm-manager-initial-model-input-facade.js";

/** Stable boot and session-attention surface layered into the manager facade. */
export abstract class SwarmManagerSessionAttentionFacade extends SwarmManagerInitialModelInputFacade {
  async boot(): Promise<void> {
    const services = this.getFacadeServices();
    await services.boot.boot();
    // Inventory and directories must exist before restored epochs are reconciled.
    await services.sessionAttention.initialize();
  }

  getSessionAttentionSnapshot() {
    return this.getFacadeServices().sessionAttention.getSnapshot();
  }

  dismissSessionAttention(attentionIds: readonly string[]) {
    return this.getFacadeServices().sessionAttention.dismissAttentionIds(attentionIds);
  }
}
