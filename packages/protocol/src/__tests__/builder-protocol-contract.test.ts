import { describe, expect, it } from 'vitest'
import {
  BUILDER_PROTOCOL_MAX_SUPPORTED,
  BUILDER_PROTOCOL_VERSION,
} from '../builder-protocol.js'
import type { CollaborationAuthor, CollaborationStatus } from '../collaboration.js'
import type { ClientCommand } from '../client-commands.js'
import type { ConversationMessageEvent } from '../conversation-events.js'
import type { ProjectPresenceEvent } from '../presence.js'
import type { ServerEvent } from '../server-events.js'
import type {
  BootstrapFailedEvent,
  ConversationHistoryEvent,
  PendingChoicesSnapshotEvent,
  ReadyEvent,
} from '../transport-events.js'
import type {
  RemoteBuildSettingsEnvOverrideErrorBody,
  RemoteBuildSettingsResponse,
} from '../settings.js'

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

  it('adds optional bootstrap correlation without changing legacy subscribe or event shapes', () => {
    const legacySubscribe = {
      type: 'subscribe',
      agentId: 'manager-1',
      conversationView: 'web',
    } satisfies Extract<ClientCommand, { type: 'subscribe' }>
    const correlatedSubscribe = {
      ...legacySubscribe,
      subscriptionId: 'renderer-1:generation-7',
    } satisfies Extract<ClientCommand, { type: 'subscribe' }>

    const legacyReady = {
      type: 'ready',
      serverTime: '2026-07-23T00:00:00.000Z',
      subscribedAgentId: 'manager-1',
    } satisfies ReadyEvent
    const correlatedReady = {
      ...legacyReady,
      subscriptionId: correlatedSubscribe.subscriptionId,
      servedConversationView: 'web',
    } satisfies ReadyEvent
    const history = {
      type: 'conversation_history',
      agentId: 'manager-1',
      messages: [],
      subscriptionId: correlatedSubscribe.subscriptionId,
      servedConversationView: 'web',
    } satisfies ConversationHistoryEvent
    const choices = {
      type: 'pending_choices_snapshot',
      agentId: 'manager-1',
      choiceIds: [],
      subscriptionId: correlatedSubscribe.subscriptionId,
      servedConversationView: 'web',
    } satisfies PendingChoicesSnapshotEvent
    const failed = {
      type: 'bootstrap_failed',
      agentId: 'manager-1',
      subscriptionId: correlatedSubscribe.subscriptionId,
      servedConversationView: 'web',
      code: 'BOOTSTRAP_FAILED',
      message: 'Conversation bootstrap failed.',
      retryable: true,
      stage: 'bootstrap',
    } satisfies BootstrapFailedEvent satisfies ServerEvent

    expect(legacySubscribe.subscriptionId).toBeUndefined()
    expect(legacyReady.subscriptionId).toBeUndefined()
    expect([correlatedReady, history, choices]).toEqual(expect.arrayContaining([
      expect.objectContaining({ subscriptionId: 'renderer-1:generation-7', servedConversationView: 'web' }),
    ]))
    expect(failed.code).toBe('BOOTSTRAP_FAILED')
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

describe('remote build settings response contract', () => {
  it('keeps legacy { settings } payloads assignable to RemoteBuildSettingsResponse', () => {
    const legacy = {
      settings: {
        enabled: false,
        terminalsEnabled: true,
        instanceName: null,
        updatedAt: null,
      },
    } satisfies RemoteBuildSettingsResponse

    expect(legacy.settings.enabled).toBe(false)
    expect(legacy.persistedSettings).toBeUndefined()
    expect(legacy.sources).toBeUndefined()
  })

  it('exposes additive effective/persisted/source fields without bumping protocol version', () => {
    const response = {
      settings: {
        enabled: true,
        terminalsEnabled: false,
        instanceName: 'Env Name',
        updatedAt: '2026-07-14T12:00:00.000Z',
      },
      persistedSettings: {
        enabled: false,
        terminalsEnabled: false,
        instanceName: null,
        updatedAt: '2026-07-14T12:00:00.000Z',
      },
      sources: {
        enabled: 'environment',
        terminalsEnabled: 'settings',
        instanceName: 'environment',
      },
    } satisfies RemoteBuildSettingsResponse

    const conflict = {
      error: 'Remote Projects settings field(s) controlled by environment variables and cannot be updated via API: enabled',
      code: 'REMOTE_BUILD_SETTINGS_ENV_OVERRIDE',
      controlledFields: ['enabled'],
    } satisfies RemoteBuildSettingsEnvOverrideErrorBody

    expect(response.sources?.enabled).toBe('environment')
    expect(response.persistedSettings?.enabled).toBe(false)
    expect(conflict.code).toBe('REMOTE_BUILD_SETTINGS_ENV_OVERRIDE')
    expect(BUILDER_PROTOCOL_VERSION).toBe(2)
  })
})
