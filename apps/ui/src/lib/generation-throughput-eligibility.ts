import type { AgentDescriptor } from '@forge/protocol'

/**
 * Builder descriptors expose model provider rather than an internal runtime
 * object. The backend runtime factory selects Cursor SDK only for this provider;
 * every other valid descriptor runs through Pi, the sole telemetry producer.
 */
export function isPiGenerationThroughputEligible(
  agent: Pick<AgentDescriptor, 'model'> | null | undefined,
): boolean {
  return Boolean(agent && agent.model.provider.trim().toLowerCase() !== 'cursor-sdk')
}
