import type { AgentContextUsage, AgentStatus } from "../types.js";
import { normalizeContextUsage } from "../swarm-manager-utils.js";

export interface RuntimeCallbackFallbackHandoffBufferedStatus {
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
}

export interface RuntimeCallbackFallbackHandoffSnapshot {
  suppressedRuntimeToken: number;
  startedAt: string;
  bufferedStatus?: RuntimeCallbackFallbackHandoffBufferedStatus;
  receivedAgentEnd?: boolean;
}

export interface RuntimeCallbackFallbackHandoffReplayHandlers {
  handleRuntimeStatus(
    runtimeToken: number,
    targetAgentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void>;
  handleRuntimeAgentEnd(runtimeToken: number, targetAgentId: string): Promise<void>;
}

export interface RuntimeCallbackGateOptions {
  getCurrentRuntimeToken(agentId: string): number | undefined;
  now?: () => string;
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
  private readonly fallbackHandoffsByAgentId = new Map<string, RuntimeCallbackFallbackHandoffSnapshot>();

  constructor(private readonly options: RuntimeCallbackGateOptions) {}

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

  beginFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    if (suppressedRuntimeToken === undefined) {
      return;
    }

    this.fallbackHandoffsByAgentId.set(agentId, {
      suppressedRuntimeToken,
      startedAt: this.options.now?.() ?? new Date().toISOString()
    });
  }

  endFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    const handoff = this.fallbackHandoffsByAgentId.get(agentId);
    if (!handoff) {
      return;
    }

    if (suppressedRuntimeToken !== undefined && handoff.suppressedRuntimeToken !== suppressedRuntimeToken) {
      return;
    }

    this.fallbackHandoffsByAgentId.delete(agentId);
  }

  getFallbackHandoffSnapshot(
    agentId: string,
    suppressedRuntimeToken?: number
  ): RuntimeCallbackFallbackHandoffSnapshot | undefined {
    if (suppressedRuntimeToken === undefined) {
      return undefined;
    }

    const handoff = this.getSuppressedFallbackHandoff(agentId, suppressedRuntimeToken);
    if (!handoff) {
      return undefined;
    }

    return {
      ...handoff,
      bufferedStatus: handoff.bufferedStatus
        ? {
            ...handoff.bufferedStatus,
            contextUsage: handoff.bufferedStatus.contextUsage
              ? { ...handoff.bufferedStatus.contextUsage }
              : undefined
          }
        : undefined
    };
  }

  async reconcileBufferedCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined,
    handlers: RuntimeCallbackFallbackHandoffReplayHandlers
  ): Promise<void> {
    if (suppressedRuntimeToken === undefined) {
      return;
    }

    const handoff = this.getFallbackHandoffSnapshot(agentId, suppressedRuntimeToken);
    this.endFallbackHandoff(agentId, suppressedRuntimeToken);
    if (!handoff) {
      return;
    }

    if (handoff.bufferedStatus) {
      await handlers.handleRuntimeStatus(
        suppressedRuntimeToken,
        agentId,
        handoff.bufferedStatus.status,
        handoff.bufferedStatus.pendingCount,
        handoff.bufferedStatus.contextUsage
      );
    }

    if (handoff.receivedAgentEnd) {
      await handlers.handleRuntimeAgentEnd(suppressedRuntimeToken, agentId);
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

    const handoff = this.getSuppressedFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.bufferedStatus = {
      status,
      pendingCount,
      contextUsage: normalizeContextUsage(contextUsage)
    };
    this.fallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  bufferAgentEndDuringHandoff(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    const handoff = this.getSuppressedFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.receivedAgentEnd = true;
    this.fallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  isSuppressedRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken === undefined) {
      return false;
    }

    if (this.isIntentionalStopRuntimeCallbackSuppressed(agentId, runtimeToken)) {
      return true;
    }

    return this.getSuppressedFallbackHandoff(agentId, runtimeToken) !== undefined;
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

  private getSuppressedFallbackHandoff(
    agentId: string,
    runtimeToken: number
  ): RuntimeCallbackFallbackHandoffSnapshot | undefined {
    const handoff = this.fallbackHandoffsByAgentId.get(agentId);
    if (handoff?.suppressedRuntimeToken === runtimeToken) {
      return handoff;
    }

    return undefined;
  }
}
