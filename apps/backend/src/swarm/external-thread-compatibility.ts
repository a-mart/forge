import { transitionAgentStatus } from "./agent-state-machine.js";
import type { AgentDescriptor, AgentStatus } from "./types.js";
import {
  CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL,
  isExternalThreadDescriptor,
  isForgeManagedRuntimeWorkerDescriptor,
  requiresForgeAgentRuntime,
  validateCodexExternalThreadModelInvariant,
} from "./external-threads.js";

export {
  CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL,
  isExternalThreadDescriptor,
  isForgeManagedRuntimeWorkerDescriptor,
  requiresForgeAgentRuntime,
  validateCodexExternalThreadModelInvariant,
};

export function assertForgeRuntimeEligibleDescriptor(
  descriptor: AgentDescriptor,
  action: string
): void {
  if (!requiresForgeAgentRuntime(descriptor)) {
    throw new Error(
      `Cannot ${action} for external-thread sidecar ${descriptor.agentId}: Forge runtime paths are not supported`
    );
  }
}

export interface InterruptExternalThreadWorkerOptions {
  abort: boolean;
  emitStatus: boolean;
  now: () => string;
  emitStatusEvent: (agentId: string, status: AgentStatus, pendingCount: number) => void;
  logDebug?: (message: string, details?: Record<string, unknown>) => void;
}

export function interruptExternalThreadWorkerDescriptor(
  descriptor: AgentDescriptor,
  options: InterruptExternalThreadWorkerOptions
): AgentDescriptor {
  if (!isExternalThreadDescriptor(descriptor)) {
    throw new Error(`Expected external-thread worker descriptor: ${descriptor.agentId}`);
  }

  descriptor.status = transitionAgentStatus(descriptor.status, "idle");
  descriptor.contextUsage = undefined;
  descriptor.streamingStartedAt = undefined;
  descriptor.updatedAt = options.now();

  options.logDebug?.("external_thread:interrupt", {
    agentId: descriptor.agentId,
    abort: options.abort,
  });

  if (options.emitStatus) {
    options.emitStatusEvent(descriptor.agentId, descriptor.status, 0);
  }

  return descriptor;
}

export function shouldPreserveExternalThreadWorkerOnSessionStop(
  descriptor: AgentDescriptor,
  deleteWorkers: boolean | undefined
): boolean {
  return isExternalThreadDescriptor(descriptor) && deleteWorkers !== true;
}

export function shouldIncludeDescriptorInBootInterruptedToolReconciliation(
  descriptor: Pick<AgentDescriptor, "status" | "externalThread">
): boolean {
  return descriptor.status === "streaming" && !isExternalThreadDescriptor(descriptor);
}

export function isActiveExternalThreadSidecar(
  descriptor: Pick<AgentDescriptor, "status" | "externalThread">
): boolean {
  return isExternalThreadDescriptor(descriptor) && descriptor.status === "streaming";
}

export function shouldInterruptExternalThreadSidecar(descriptor: AgentDescriptor): boolean {
  return isActiveExternalThreadSidecar(descriptor);
}

export function shouldReportWorkerAsTerminatedOnSessionStop(
  descriptor: AgentDescriptor,
  deleteWorkers: boolean | undefined
): boolean {
  return !shouldPreserveExternalThreadWorkerOnSessionStop(descriptor, deleteWorkers);
}

export interface ReconcilePersistedExternalThreadSidecarsForBootOptions {
  descriptors: Iterable<AgentDescriptor>;
  now: () => string;
  upsertDescriptor: (descriptor: AgentDescriptor) => void;
}

export function reconcilePersistedExternalThreadSidecarsForBoot(
  options: ReconcilePersistedExternalThreadSidecarsForBootOptions
): string[] {
  const reconciledAgentIds: string[] = [];

  for (const descriptor of options.descriptors) {
    if (!isExternalThreadDescriptor(descriptor) || descriptor.status !== "streaming") {
      continue;
    }

    interruptExternalThreadWorkerDescriptor(descriptor, {
      abort: true,
      emitStatus: false,
      now: options.now,
      emitStatusEvent: () => {},
    });
    options.upsertDescriptor(descriptor);
    reconciledAgentIds.push(descriptor.agentId);
  }

  return reconciledAgentIds;
}
