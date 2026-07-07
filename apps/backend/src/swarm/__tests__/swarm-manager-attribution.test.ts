import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ConversationMessageEvent } from '@forge/protocol'
import { createTempConfig } from '../../test-support/temp-config.js'
import { TestSwarmManager, bootWithDefaultManager } from '../../test-support/swarm-manager-harness.js'
import { getSessionTurnLedgerPath } from '../storage/data-paths.js'
import { replayTurnLedger } from '../turn-ledger.js'

/**
 * Wave R attribution round-trip (SPEC §4.5, §4.6 — merge gate #3):
 * a user message carrying a collaboration author is persisted with
 * `collaborationAuthor`, echoes `clientRequestId` on the broadcast event,
 * mints its turn with `initiatedBy = userId`, and does NOT flip the assistant
 * output target to the collab-channel path (no channelId = builder message).
 */
describe('swarm manager builder attribution', () => {
  it('stamps collaborationAuthor + clientRequestId and mints initiatedBy', async () => {
    const handle = await createTempConfig({ prefix: 'forge-attribution-' })
    try {
      const manager = new TestSwarmManager(handle.config)
      const descriptor = await bootWithDefaultManager(manager, handle.config)

      const events: ConversationMessageEvent[] = []
      manager.on('conversation_message', (event: ConversationMessageEvent) => {
        events.push(event)
      })

      await manager.handleUserMessage('hello from a member', {
        targetAgentId: descriptor.agentId,
        collaborationAuthor: { userId: 'user-ada', displayName: 'Ada', role: 'member' },
        clientRequestId: 'req-123',
      })

      // Broadcast event carries attribution + the clientRequestId echo.
      const userEvent = events.find((event) => event.role === 'user')
      expect(userEvent).toBeTruthy()
      expect(userEvent?.collaborationAuthor).toMatchObject({
        userId: 'user-ada',
        displayName: 'Ada',
        role: 'member',
      })
      expect(userEvent?.collaborationAuthor?.channelId).toBeUndefined()
      expect(userEvent?.clientRequestId).toBe('req-123')

      // Persisted transcript (session.jsonl custom entries) carries the same
      // attribution.
      const sessionRaw = await readFile(descriptor.sessionFile, 'utf8')
      const persisted = sessionRaw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
        .filter((line) => line.customType === 'swarm_conversation_entry')
        .map((line) => line.data ?? {})
        .find(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'user' &&
            typeof entry.text === 'string' &&
            (entry.text as string).includes('hello from a member'),
        )
      expect(persisted).toBeTruthy()
      expect(persisted?.collaborationAuthor).toMatchObject({ userId: 'user-ada', role: 'member' })
      expect(persisted?.clientRequestId).toBe('req-123')

      // The manager-visible runtime text names the author but must NOT be
      // routed as a collaboration channel turn (no channelId → builder).
      const runtime = manager.runtimeByAgentId.get(descriptor.agentId)
      expect(runtime).toBeTruthy()
      const lastSend = runtime!.sendCalls.at(-1)
      const runtimeText =
        typeof lastSend?.message === 'string' ? lastSend.message : JSON.stringify(lastSend?.message ?? '')
      expect(runtimeText).toContain('Ada')
      expect(runtimeText).not.toContain('collaboration_channel')

      // Turn ledger minted the dispatch with the author's user id.
      const ledger = await replayTurnLedger({
        dataDir: handle.config.paths.dataDir,
        profileId: descriptor.profileId ?? descriptor.agentId,
        sessionAgentId: descriptor.agentId,
      })
      const dispatched = ledger.records.filter((record) => record.t === 'turn_dispatched')
      expect(dispatched.length).toBeGreaterThan(0)
      expect(dispatched.at(-1)).toMatchObject({ kind: 'user', initiatedBy: 'user-ada' })
      expect(getSessionTurnLedgerPath(handle.config.paths.dataDir, descriptor.profileId ?? descriptor.agentId, descriptor.agentId)).toBeTruthy()
    } finally {
      await handle.cleanup()
    }
  })

  it('marks unattributed local turns as initiatedBy local with no author fields', async () => {
    const handle = await createTempConfig({ prefix: 'forge-attribution-local-' })
    try {
      const manager = new TestSwarmManager(handle.config)
      const descriptor = await bootWithDefaultManager(manager, handle.config)

      const events: ConversationMessageEvent[] = []
      manager.on('conversation_message', (event: ConversationMessageEvent) => {
        events.push(event)
      })

      await manager.handleUserMessage('plain local message', {
        targetAgentId: descriptor.agentId,
      })

      const userEvent = events.find((event) => event.role === 'user')
      expect(userEvent).toBeTruthy()
      expect(userEvent?.collaborationAuthor).toBeUndefined()
      expect(userEvent?.clientRequestId).toBeUndefined()

      const ledger = await replayTurnLedger({
        dataDir: handle.config.paths.dataDir,
        profileId: descriptor.profileId ?? descriptor.agentId,
        sessionAgentId: descriptor.agentId,
      })
      const dispatched = ledger.records.filter((record) => record.t === 'turn_dispatched')
      expect(dispatched.at(-1)).toMatchObject({ kind: 'user', initiatedBy: 'local' })
    } finally {
      await handle.cleanup()
    }
  })
})
