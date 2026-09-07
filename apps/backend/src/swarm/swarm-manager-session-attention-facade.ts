import type { HistorySessionsRequest, HistorySessionsResponse } from "@forge/protocol";
import { SwarmManagerInitialModelInputFacade } from "./swarm-manager-initial-model-input-facade.js";

/** Stable boot and session-attention surface layered into the manager facade. */
export abstract class SwarmManagerSessionAttentionFacade extends SwarmManagerInitialModelInputFacade {
  async boot(): Promise<void> {
    const services = this.getFacadeServices();
    await services.boot.boot();
    await services.conversation.history.startFromRegistry();
    // Inventory and directories must exist before restored epochs are reconciled.
    await services.sessionAttention.initialize();
  }

  listHistorySessions(callerAgentId: string, request: HistorySessionsRequest): Promise<HistorySessionsResponse> {
    return this.getFacadeServices().conversation.history.sessions(callerAgentId, request);
  }

  getHistoryIndexStatus() {
    return this.getFacadeServices().conversation.history.getIndexStatus();
  }

  setHistoryIndexPaused(paused: boolean) {
    return this.getFacadeServices().conversation.history.setIndexPaused(paused);
  }

  getSessionAttentionSnapshot() {
    return this.getFacadeServices().sessionAttention.getSnapshot();
  }

  dismissSessionAttention(attentionIds: readonly string[]) {
    return this.getFacadeServices().sessionAttention.dismissAttentionIds(attentionIds);
  }
}
