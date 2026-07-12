import { describe, expect, it } from 'vitest'
import {
  BUILDER_PROTOCOL_MAX_SUPPORTED,
  BUILDER_PROTOCOL_VERSION,
} from '../builder-protocol.js'
import type { CollaborationAuthor, CollaborationStatus } from '../collaboration.js'
import type { ClientCommand } from '../client-commands.js'
import type { ConversationMessageEvent } from '../conversation-events.js'
import type { ProjectPresenceEvent } from '../presence.js'

/**
 * Wave R contract fixtures (SPEC §6): every wire change is additive-optional,
 * so an N client must accept an N±1 server payload and vice versa. These
 * fixtures pin the shapes for the handshake, attribution, and clientRequestId.
 */
describe('builder protocol contract', () => {
  it('pins the version constants', () => {
    expect(BUILDER_PROTOCOL_VERSION).toBe(2)
    expect(BUILDER_PROTOCOL_MAX_SUPPORTED).toBeGreaterThanOrEqual(BUILDER_PROTOCOL_VERSION)
  })

  it('handshake fields are additive: pre-Wave-R status payloads remain valid', () => {
    const legacyServerStatus = {
      enabled: true,
      adminExists: true,
      ready: true,
      bootstrapState: 'ready',
    } satisfies CollaborationStatus

    const waveRServerStatus = {
      enabled: true,
      adminExists: true,
      ready: true,
      bootstrapState: 'ready',
      instanceName: 'Central Forge',
      forgeVersion: '0.9.0',
      protocolVersion: 1,
      capabilities: { collab: true, remoteBuild: true },
    } satisfies CollaborationStatus

    expect(legacyServerStatus.protocolVersion).toBeUndefined()
    expect(legacyServerStatus.capabilities).toBeUndefined()
    expect(waveRServerStatus.capabilities.remoteBuild).toBe(true)
    // A client treats a missing protocolVersion as a pre-Wave-R instance —
    // never version-blocked (blocking only applies to versions ABOVE the
    // client ceiling).
    expect((legacyServerStatus.protocolVersion ?? 0) <= BUILDER_PROTOCOL_MAX_SUPPORTED).toBe(true)
  })

  it('user_message.clientRequestId is optional on the command', () => {
    const withoutId = {
      type: 'user_message',
      text: 'hello',
    } satisfies Extract<ClientCommand, { type: 'user_message' }>

    const withId = {
      type: 'user_message',
      text: 'hello',
      clientRequestId: '3e4f9d34-4a17-4c30-9be6-2f1c7c8e2f10',
    } satisfies Extract<ClientCommand, { type: 'user_message' }>

    expect(withoutId.clientRequestId).toBeUndefined()
    expect(withId.clientRequestId).toBeTruthy()
  })

  it('conversation_message echoes clientRequestId and carries builder attribution', () => {
    const collabAuthor = {
      userId: 'user-1',
      displayName: 'Ada',
      role: 'member',
      workspaceId: 'ws-1',
      channelId: 'chan-1',
    } satisfies CollaborationAuthor

    // Builder attribution: identity without channel context. Absence of
    // channelId is the "not a collab channel" discriminator.
    const builderAuthor = {
      userId: 'user-1',
      displayName: 'Ada',
      role: 'member',
    } satisfies CollaborationAuthor

    const event = {
      type: 'conversation_message',
      agentId: 'agent-1',
      role: 'user',
      text: 'hello',
      timestamp: '2026-07-07T12:00:00.000Z',
      source: 'user_input',
      collaborationAuthor: builderAuthor,
      clientRequestId: '3e4f9d34-4a17-4c30-9be6-2f1c7c8e2f10',
    } satisfies ConversationMessageEvent

    const legacyEvent = {
      type: 'conversation_message',
      agentId: 'agent-1',
      role: 'user',
      text: 'hello',
      timestamp: '2026-07-07T12:00:00.000Z',
      source: 'user_input',
    } satisfies ConversationMessageEvent

    expect(collabAuthor.channelId).toBe('chan-1')
    expect(builderAuthor.channelId).toBeUndefined()
    expect(event.clientRequestId).toBeTruthy()
    expect(legacyEvent.collaborationAuthor).toBeUndefined()
    expect(legacyEvent.clientRequestId).toBeUndefined()
  })
})

describe('project_presence contract (R3)', () => {
  it('carries a full viewer snapshot per session and tolerates empty sets', () => {
    const populated = {
      type: 'project_presence',
      sessionAgentId: 'agent-1',
      profileId: 'profile-1',
      viewers: [
        { userId: 'u1', displayName: 'Ada', role: 'member' },
        { userId: 'u2', displayName: 'Root', role: 'admin' },
      ],
    } satisfies ProjectPresenceEvent

    const empty = {
      type: 'project_presence',
      sessionAgentId: 'agent-1',
      viewers: [],
    } satisfies ProjectPresenceEvent

    expect(populated.viewers).toHaveLength(2)
    expect(empty.profileId).toBeUndefined()
  })
})
