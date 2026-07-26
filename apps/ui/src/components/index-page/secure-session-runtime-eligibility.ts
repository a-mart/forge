import type { AgentDescriptor } from '@forge/protocol'

/**
 * Providers that must never initiate Secure Sessions grant/session setup.
 * `claude-sdk` is retained only as an unsupported compatibility tombstone for
 * unknown persisted legacy descriptors that remain unavailable after retirement.
 */
const UNSUPPORTED_SECURE_SESSION_PROVIDERS = new Set([
  'claude-sdk',
  'cursor-sdk',
])

export function isSecureSessionRuntimeSupported(
  agent: AgentDescriptor | null | undefined,
): boolean {
  if (!agent || agent.externalThread) return false
  return !UNSUPPORTED_SECURE_SESSION_PROVIDERS.has(
    agent.model.provider.trim().toLowerCase(),
  )
}
