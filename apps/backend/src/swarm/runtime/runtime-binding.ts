import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import { createForgeBindingToken } from "../forge-extension-types.js";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import { compareRuntimeExtensionSnapshots } from "../swarm-manager-utils.js";

export interface RuntimeBindingOptions {
  deactivateRuntimeBindings(bindingToken: string): void;
  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void;
}

/**
 * Owns the mutable runtime binding state for agent runtimes.
 *
 * The exposed maps intentionally remain stable object identities so the legacy
 * SwarmRuntimeController facade and fallback-manager options can keep sharing
 * the same compatibility surfaces while ownership moves out of the controller.
 */
export class RuntimeBinding {
  readonly runtimes = new Map<string, SwarmAgentRuntime>();
  readonly runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
  readonly runtimeTokensByAgentId = new Map<string, number>();
  readonly runtimeExtensionSnapshotsByAgentId = new Map<string, AgentRuntimeExtensionSnapshot>();

  private nextRuntimeToken = 1;

  constructor(private readonly options: RuntimeBindingOptions) {}

  allocateRuntimeToken(agentId: string): number {
    const token = this.nextRuntimeToken;
    this.nextRuntimeToken += 1;
    this.runtimeTokensByAgentId.set(agentId, token);
    return token;
  }

  getRuntimeToken(agentId: string): number | undefined {
    return this.runtimeTokensByAgentId.get(agentId);
  }

  isCurrentRuntimeToken(agentId: string, runtimeToken: number): boolean {
    return this.runtimeTokensByAgentId.get(agentId) === runtimeToken;
  }

  clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    const isCurrentRuntime = runtimeToken === undefined || this.isCurrentRuntimeToken(agentId, runtimeToken);

    if (runtimeToken !== undefined) {
      this.options.deactivateRuntimeBindings(createForgeBindingToken(runtimeToken));
    }
    this.options.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken);

    if (!isCurrentRuntime) {
      return;
    }

    this.runtimeTokensByAgentId.delete(agentId);
    this.runtimeExtensionSnapshotsByAgentId.delete(agentId);
  }

  attachRuntime(agentId: string, runtime: SwarmAgentRuntime): void {
    this.runtimes.set(agentId, runtime);
  }

  detachRuntime(agentId: string, runtimeToken?: number): boolean {
    if (runtimeToken !== undefined && !this.isCurrentRuntimeToken(agentId, runtimeToken)) {
      this.clearRuntimeToken(agentId, runtimeToken);
      return false;
    }

    this.runtimes.delete(agentId);
    this.clearRuntimeToken(agentId, runtimeToken);
    return true;
  }

  recordRuntimeExtensionSnapshot(agentId: string, snapshot: AgentRuntimeExtensionSnapshot): void {
    this.runtimeExtensionSnapshotsByAgentId.set(agentId, cloneRuntimeExtensionSnapshot(snapshot));
  }

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return Array.from(this.runtimeExtensionSnapshotsByAgentId.values())
      .map((snapshot) => cloneRuntimeExtensionSnapshot(snapshot))
      .sort(compareRuntimeExtensionSnapshots);
  }
}

function cloneRuntimeExtensionSnapshot(snapshot: AgentRuntimeExtensionSnapshot): AgentRuntimeExtensionSnapshot {
  return {
    ...snapshot,
    extensions: snapshot.extensions.map((extension) => ({
      ...extension,
      events: [...extension.events],
      tools: [...extension.tools]
    })),
    loadErrors: snapshot.loadErrors.map((error) => ({ ...error }))
  };
}
