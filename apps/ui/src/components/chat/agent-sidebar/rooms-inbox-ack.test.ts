import { describe, expect, it } from 'vitest'
import type { RoomsInboxAcknowledgement } from './rooms-inbox-ack'
import {
  acknowledgeRoomsInboxEntries,
  garbageCollectRoomsInboxAcknowledgements,
  getRoomsInboxAcknowledgementKey,
  reconcileRoomsInboxAcknowledgements,
} from './rooms-inbox-ack'
import type { RoomsInboxOriginInput, RoomsInboxSessionInput } from './rooms-inbox-selectors'
import { selectRoomsInboxSections } from './rooms-inbox-selectors'

const NOW = Date.parse('2026-08-03T12:00:00.000Z')

function session(
  originId: string,
  agentId: string,
  overrides: Partial<RoomsInboxSessionInput> = {},
): RoomsInboxSessionInput {
  return {
    identity: { originId, profileId: `${originId}-project`, sessionAgentId: agentId },
    label: `${originId} ${agentId}`,
    profileName: `${originId} project`,
    agentStatus: 'idle',
    activeWorkerCount: 0,
    pendingChoiceCount: 0,
    unreadCount: 0,
    contextRecoveryInProgress: false,
    updatedAt: '2026-08-03T11:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  }
}

function origin(...sessions: RoomsInboxSessionInput[]): RoomsInboxOriginInput {
  const originId = sessions[0]?.identity.originId ?? 'local'
  return { originId, connected: true, sessions, projects: [] }
}

function sessionKey(value: RoomsInboxSessionInput): string {
  return getRoomsInboxAcknowledgementKey(value.identity.originId, value.identity.sessionAgentId)
}

describe('Rooms Inbox acknowledgement reconciliation', () => {
  it('keeps an unread row after viewing clears unreadCount and removes it only after Done', () => {
    const unread = session('local', 'same', { unreadCount: 2 })
    const key = sessionKey(unread)
    const existing = new Set([key])
    let entries = reconcileRoomsInboxAcknowledgements({}, [{
      key,
      reason: 'unread_result',
      signature: 'unread:2:2026-08-03T11:00:00.000Z',
    }], existing, NOW)

    const viewed = { ...unread, unreadCount: 0 }
    entries = reconcileRoomsInboxAcknowledgements(entries, [], existing, NOW + 1)
    expect(selectRoomsInboxSections([origin(viewed)], { attentionEntries: entries, now: NOW + 1 }).needsYou)
      .toMatchObject([{ identity: unread.identity, reason: 'unread_result' }])

    entries = acknowledgeRoomsInboxEntries(entries, [key], NOW + 2)
    entries = reconcileRoomsInboxAcknowledgements(entries, [], existing, NOW + 3, new Set(['local']))
    const dismissedSections = selectRoomsInboxSections([origin(viewed)], { attentionEntries: entries, now: NOW + 3 })
    expect(entries[key]?.clearedAt).toBe(NOW + 3)
    expect(dismissedSections.needsYou).toEqual([])
    expect(dismissedSections.recent).toEqual([])
  })

  it('suppresses a continuously-live dismissed choice but re-raises after a same-count choice resolves and recurs', () => {
    const waiting = session('local', 'choice', { pendingChoiceCount: 1 })
    const key = sessionKey(waiting)
    const existing = new Set([key])
    const authoritativeOrigins = new Set(['local'])
    let entries = reconcileRoomsInboxAcknowledgements({}, [{
      key,
      reason: 'awaiting_choice',
      signature: 'choice:1',
    }], existing, NOW, authoritativeOrigins)
    entries = acknowledgeRoomsInboxEntries(entries, [key], NOW + 1)

    // The same choice stays live, so its dismissal remains in force.
    entries = reconcileRoomsInboxAcknowledgements(entries, [{
      key,
      reason: 'awaiting_choice',
      signature: 'choice:1',
    }], existing, NOW + 2, authoritativeOrigins)
    expect(entries[key]?.ackedAt).toBe(NOW + 1)
    expect(selectRoomsInboxSections([origin(waiting)], { attentionEntries: entries, now: NOW + 2 }).needsYou)
      .toEqual([])

    // Resolution records a tombstone rather than deleting it. A later
    // one-choice prompt re-raises because it follows this observed clear.
    entries = reconcileRoomsInboxAcknowledgements(entries, [], existing, NOW + 3, authoritativeOrigins)
    expect(entries[key]).toMatchObject({ ackedAt: NOW + 1, clearedAt: NOW + 3 })
    entries = reconcileRoomsInboxAcknowledgements(entries, [{ 
      key,
      reason: 'awaiting_choice',
      signature: 'choice:1',
    }], existing, NOW + 4, authoritativeOrigins)
    expect(entries[key]?.ackedAt).toBeUndefined()
    expect(selectRoomsInboxSections([origin(waiting)], { attentionEntries: entries, now: NOW + 4 }).needsYou)
      .toMatchObject([{ identity: waiting.identity, reason: 'awaiting_choice' }])
  })

  it('isolates acknowledgements for colliding session IDs on different origins', () => {
    const local = session('local', 'colliding', { unreadCount: 1 })
    const remote = session('remote', 'colliding', { unreadCount: 1 })
    const localKey = sessionKey(local)
    const remoteKey = sessionKey(remote)
    const entries = reconcileRoomsInboxAcknowledgements({}, [
      { key: localKey, reason: 'unread_result', signature: 'unread:1:2026-08-03T11:00:00.000Z' },
      { key: remoteKey, reason: 'unread_result', signature: 'unread:1:2026-08-03T11:00:00.000Z' },
    ], new Set([localKey, remoteKey]), NOW)
    const acknowledged = acknowledgeRoomsInboxEntries(entries, [localKey], NOW + 1)

    expect(acknowledged[localKey]?.ackedAt).toBe(NOW + 1)
    expect(acknowledged[remoteKey]?.ackedAt).toBeUndefined()
    expect(selectRoomsInboxSections([origin(local), origin(remote)], {
      attentionEntries: acknowledged,
      now: NOW + 1,
    }).needsYou.map((entry) => entry.identity.originId)).toEqual(['remote'])
  })

  it('acknowledges every listed row without changing unread counts', () => {
    const first = session('local', 'first', { unreadCount: 3 })
    const second = session('local', 'second', { unreadCount: 4 })
    const keys = [sessionKey(first), sessionKey(second)]
    const entries = reconcileRoomsInboxAcknowledgements({}, [
      { key: keys[0], reason: 'unread_result', signature: 'unread:3:one' },
      { key: keys[1], reason: 'unread_result', signature: 'unread:4:two' },
    ], new Set(keys), NOW)
    const acknowledged = acknowledgeRoomsInboxEntries(entries, keys, NOW + 1)

    expect(Object.values(acknowledged).every((entry) => entry.ackedAt === NOW + 1)).toBe(true)
    expect(first.unreadCount).toBe(3)
    expect(second.unreadCount).toBe(4)
  })

  it('retains an acknowledgement through an unready empty inventory and collects it once that origin is authoritative', () => {
    const key = 'local::deleted-session'
    const entries = {
      [key]: { reason: 'error' as const, signature: 'error:one', raisedAt: NOW, ackedAt: NOW },
    }

    const beforeBootstrap = reconcileRoomsInboxAcknowledgements(entries, [], new Set(), NOW + 1, new Set())
    expect(beforeBootstrap[key]).toEqual(entries[key])

    const afterAuthoritativeDeletion = reconcileRoomsInboxAcknowledgements(
      beforeBootstrap,
      [],
      new Set(),
      NOW + 2,
      new Set(['local']),
    )
    expect(afterAuthoritativeDeletion[key]).toBeUndefined()
  })

  it('keeps a delimiter-bearing origin unready even when its origin prefix is authoritative', () => {
    const key = 'local::nested::session'
    const entries = {
      [key]: { reason: 'error' as const, signature: 'error:one', raisedAt: NOW, ackedAt: NOW },
    }
    const retained = reconcileRoomsInboxAcknowledgements(
      entries,
      [],
      new Set(),
      NOW + 1,
      new Set(['local']),
      new Set(['local', 'local::nested']),
    )
    expect(retained[key]).toEqual(entries[key])
  })

  it('garbage-collects stale entries and retains only the 200 newest sessions', () => {
    const entries: Record<string, RoomsInboxAcknowledgement> = Object.fromEntries(Array.from({ length: 205 }, (_, index) => [
      `local::session-${index}`,
      { reason: 'unread_result' as const, signature: `unread:${index}`, raisedAt: NOW + index },
    ]))
    entries['local::stale-ack'] = {
      reason: 'error',
      signature: 'error:old',
      raisedAt: NOW,
      ackedAt: NOW - 31 * 24 * 60 * 60 * 1000,
    }
    entries['local::gone'] = {
      reason: 'error',
      signature: 'error:gone',
      raisedAt: NOW + 999,
    }
    const existing = new Set([
      ...Array.from({ length: 205 }, (_, index) => `local::session-${index}`),
      'local::stale-ack',
    ])

    const collected = garbageCollectRoomsInboxAcknowledgements(entries, existing, NOW)
    expect(Object.keys(collected)).toHaveLength(200)
    expect(collected['local::session-204']).toBeDefined()
    expect(collected['local::session-0']).toBeUndefined()
    expect(collected['local::stale-ack']).toBeUndefined()
    expect(collected['local::gone']).toBeUndefined()
  })
})
