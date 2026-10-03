import type { AgentInitialModelInputState, HistorySessionsRequest, HistorySessionsResponse, HistoryItemsRequest, HistoryItemsResponse, HistoryWindowsRequest, HistoryWindowsResponse } from "@forge/protocol";
import { SwarmManagerDelegationFacade } from "./swarm-manager-delegation-facade.js";
import { readInitialModelInputForViewer } from "./runtime/initial-model-input-viewer.js";

/** Stable boot, session-attention, and initial model-input viewer surface layered into the manager facade. */
export abstract class SwarmManagerSessionAttentionFacade extends SwarmManagerDelegationFacade {
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

  listHistoryItems(callerAgentId: string, request: HistoryItemsRequest): Promise<HistoryItemsResponse> {
    return this.getFacadeServices().conversation.history.items(callerAgentId, request);
  }

  listHistoryWindows(callerAgentId: string, request: HistoryWindowsRequest): Promise<HistoryWindowsResponse> {
    return this.getFacadeServices().conversation.history.windows(callerAgentId, request);
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

  getAgentInitialModelInputForRead(agentId: string): AgentInitialModelInputState {
    const services = this.getFacadeServices();
    return readInitialModelInputForViewer(
      services.registry.directory.getAgent(agentId),
      services.runtime.runtimes.get(agentId),
    );
  }
}
