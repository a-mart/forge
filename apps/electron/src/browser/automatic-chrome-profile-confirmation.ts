import type { ExternalChromeRuntimeInventory } from '../external-chrome/relay-runtime.js'
import type { ExternalChromeTransport } from './external-chrome-target-adapter.js'

export interface ProfileConfirmingChromeTransport extends ExternalChromeTransport {
  inventory(): ExternalChromeRuntimeInventory[]
  confirmAutomaticInstance(sessionAgentId: string, profileId: string, extensionInstanceId: string): void
}

/** Adds the sole allowed Chrome-profile prompt while keeping instance identity out of the renderer. */
export function withSessionProfileConfirmation(
  transport: ProfileConfirmingChromeTransport,
  choose: (labels: string[]) => Promise<number | null>,
): ExternalChromeTransport {
  const promptedSessions = new Set<string>()
  return {
    maxResponseBytes: transport.maxResponseBytes,
    execute: (request) => transport.execute(request),
    releaseAuthority: (session, authority, reason) => transport.releaseAuthority?.(session, authority, reason) ?? Promise.resolve(),
    revealTarget: (session, tabId) => {
      if (!transport.revealTarget) return Promise.reject(new Error('Chrome reveal is unavailable.'))
      return transport.revealTarget(session, tabId)
    },
    acquireTarget: async (input) => {
      if (!transport.acquireTarget) throw new Error('Chrome acquisition is unavailable.')
      const result = await transport.acquireTarget(input)
      if (result.ok || result.metadata.fallbackReason !== 'ambiguous-instance') return result
      const sessionKey = `${input.sessionAgentId}\0${input.profileId}`
      if (promptedSessions.has(sessionKey)) return result
      promptedSessions.add(sessionKey)
      const profiles = transport.inventory()
      if (profiles.length < 2) return result
      const labels = profiles.map((_profile, index) => `Chrome profile ${index + 1}`)
      const selectedIndex = await choose(labels)
      const selected = selectedIndex === null ? undefined : profiles[selectedIndex]
      if (!selected) return result
      transport.confirmAutomaticInstance(input.sessionAgentId, input.profileId, selected.extensionInstanceId)
      return transport.acquireTarget(input)
    },
  }
}
