import type { AutomaticChromeProfileChoice } from '../external-chrome/relay-runtime.js'
import type { ExternalChromeTransport } from './external-chrome-target-adapter.js'

export interface ProfileConfirmingChromeTransport extends ExternalChromeTransport {
  automaticProfileChoices(): AutomaticChromeProfileChoice[]
  confirmAutomaticChoice(sessionAgentId: string, profileId: string, token: string): boolean
}

/** Adds the sole allowed Chrome-profile prompt while keeping runtime identity out of the renderer. */
export function withSessionProfileConfirmation(
  transport: ProfileConfirmingChromeTransport,
  choose: (labels: string[]) => Promise<number | null>,
): ExternalChromeTransport {
  const promptedSessions = new Set<string>()
  return {
    maxResponseBytes: transport.maxResponseBytes,
    execute: (request) => transport.execute(request),
    releaseAuthority: (session, authority, reason) => transport.releaseAuthority?.(session, authority, reason) ?? Promise.resolve(),
    endTurn: (session, turnId) => transport.endTurn?.(session, turnId) ?? Promise.resolve(),
    releaseSession: (session, reason) => transport.releaseSession?.(session, reason) ?? Promise.resolve(),
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
      const choices = transport.automaticProfileChoices()
      if (choices.length < 2) return result
      const selectedIndex = await choose(choices.map((choice) => choice.label))
      const selected = selectedIndex === null ? undefined : choices[selectedIndex]
      if (!selected || !transport.confirmAutomaticChoice(input.sessionAgentId, input.profileId, selected.token)) return result
      return transport.acquireTarget(input)
    },
  }
}
