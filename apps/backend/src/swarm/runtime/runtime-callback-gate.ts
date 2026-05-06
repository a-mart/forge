import type { AgentContextUsage, AgentStatus } from "../types.js";

export interface RuntimeCallbackFallbackHandoffAdapter {
  bufferStatusDuringHandoff(
    agentId: string,
    runtimeToken: number,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): boolean;
  bufferAgentEndDuringHandoff(agentId: string, runtimeToken: number): boolean;
  isSuppressedRuntimeCallback(agentId: string, runtimeToken?: number): boolean;
}

export interface RuntimeCallbackGateOptions {
  getCurrentRuntimeToken(agentId: string): number | undefined;
  fallbackHandoff?: RuntimeCallbackFallbackHandoffAdapter | null;
}

/**
 * Central ingress gate for callbacks emitted by agent runtimes.
 *
 * The gate owns callback suppression state that is independent from runtime binding ownership.
 * Runtime token ownership remains in SwarmRuntimeController and is exposed here through a reader
 * so stale-token detection cannot mutate controller runtime maps.
 */
export class RuntimeCallbackGate {
  private readonly intentionallyStoppedRuntimeTokensByAgentId = new Map<string, Set<number>>();
  private fallbackHandoff: RuntimeCallbackFallbackHandoffAdapter | null;

  constructor(private readonly options: RuntimeCallbackGateOptions) {
    this.fallbackHandoff = options.fallbackHandoff ?? null;
  }

  setFallbackHandoffAdapter(adapter: RuntimeCallbackFallbackHandoffAdapter | null): void {
    this.fallbackHandoff = adapter;
  }

  suppressIntentionalStopRuntimeCallbacks(agentId: string, runtimeToken?: number): void {
    if (runtimeToken === undefined) {
      return;
    }

    let suppressedTokens = this.intentionallyStoppedRuntimeTokensByAgentId.get(agentId);
    if (!suppressedTokens) {
      suppressedTokens = new Set<number>();
      this.intentionallyStoppedRuntimeTokensByAgentId.set(agentId, suppressedTokens);
    }

    suppressedTokens.add(runtimeToken);
  }

  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void {
    if (runtimeToken === undefined) {
      this.intentionallyStoppedRuntimeTokensByAgentId.delete(agentId);
      return;
    }

    const suppressedTokens = this.intentionallyStoppedRuntimeTokensByAgentId.get(agentId);
    if (!suppressedTokens) {
      return;
    }

    suppressedTokens.delete(runtimeToken);
    if (suppressedTokens.size === 0) {
      this.intentionallyStoppedRuntimeTokensByAgentId.delete(agentId);
    }
  }

  bufferStatusDuringHandoff(
    agentId: string,
    runtimeToken: number | undefined,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    return this.fallbackHandoff?.bufferStatusDuringHandoff(
      agentId,
      runtimeToken,
      status,
      pendingCount,
      contextUsage
    ) === true;
  }

  bufferAgentEndDuringHandoff(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    return this.fallbackHandoff?.bufferAgentEndDuringHandoff(agentId, runtimeToken) === true;
  }

  isSuppressedRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.isIntentionalStopRuntimeCallbackSuppressed(agentId, runtimeToken)) {
      return true;
    }

    return this.fallbackHandoff?.isSuppressedRuntimeCallback(agentId, runtimeToken) === true;
  }

  shouldIgnoreRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.isSuppressedRuntimeCallback(agentId, runtimeToken)) {
      return true;
    }

    return this.options.getCurrentRuntimeToken(agentId) !== runtimeToken;
  }

  private isIntentionalStopRuntimeCallbackSuppressed(agentId: string, runtimeToken: number): boolean {
    return this.intentionallyStoppedRuntimeTokensByAgentId.get(agentId)?.has(runtimeToken) === true;
  }
}
