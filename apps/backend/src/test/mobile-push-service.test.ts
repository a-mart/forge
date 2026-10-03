import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionAttention } from '@forge/protocol'
import type { AgentDescriptor, ManagerProfile } from '../swarm/types.js'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import { getSharedMobileDevicesPath } from '../swarm/data-paths.js'
import { NotificationSettingsService } from '../swarm/notification-settings-service.js'
import { ExpoPushClient } from '../mobile/expo-push-client.js'
import { MobilePushService } from '../mobile/mobile-push-service.js'

class FakeSwarmManager extends EventEmitter {
  private readonly descriptors = new Map<string, AgentDescriptor>()
  private readonly profiles = new Map<string, ManagerProfile>()

  constructor(descriptors: AgentDescriptor[], profiles: ManagerProfile[] = []) {
    super()
    for (const descriptor of descriptors) {
      this.descriptors.set(descriptor.agentId, descriptor)
    }
    for (const profile of profiles) {
      this.profiles.set(profile.profileId, profile)
    }
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.descriptors.get(agentId)
  }

  listProfiles(): ManagerProfile[] {
    return Array.from(this.profiles.values())
  }

  initialAttentions: SessionAttention[] = []

  getSessionAttentionSnapshot(): { revision: number; attentions: SessionAttention[] } {
    return { revision: 0, attentions: this.initialAttentions }
  }
}

let attentionSequence = 0
let attentionRevision = 0

function attention(
  sessionAgentId: string,
  reason: SessionAttention['reason'] = 'work_settled',
  attentionId = `attention-${++attentionSequence}`,
): SessionAttention {
  return { attentionId, sessionAgentId, profileId: 'profile-a', reason, raisedAt: new Date().toISOString() }
}

function emitAttentionSnapshot(manager: FakeSwarmManager, attentions: SessionAttention[]): void {
  manager.emit('session_attention_snapshot', {
    type: 'session_attention_snapshot',
    revision: ++attentionRevision,
    attentions,
  })
}

/** Raises one new Needs-you attention for the session. */
function emitAttention(manager: FakeSwarmManager, sessionAgentId: string): void {
  emitAttentionSnapshot(manager, [attention(sessionAgentId)])
}

function createManagerDescriptor(
  profileId = 'profile-a',
  agentId = 'manager',
  sessionPurpose?: AgentDescriptor['sessionPurpose'],
): AgentDescriptor {
  return {
    agentId,
    displayName: 'Manager',
    role: 'manager',
    managerId: agentId,
    status: 'idle',
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    sessionPurpose,
  }
}

function createTestProfile(profileId = 'profile-a', displayName = 'Forge'): ManagerProfile {
  return {
    profileId,
    displayName,
    defaultSessionAgentId: 'manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
  }
}

function createWorkerDescriptor(managerId = 'manager', agentId = 'worker-1'): AgentDescriptor {
  return {
    agentId,
    displayName: 'Backend Specialist',
    role: 'worker',
    managerId,
    status: 'idle',
    createdAt: '2026-03-12T00:00:00.000Z',
    updatedAt: '2026-03-12T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'medium',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (condition()) {
      return
    }

    await flushAsync()
  }

  throw new Error('Timed out waiting for async condition')
}

async function waitForAsyncCondition(
  condition: () => Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }

    await flushAsync()
  }

  throw new Error('Timed out waiting for async condition')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MobilePushService', () => {
  it('pushes a Needs-you attention with contextual session titles, reason copy and routing data', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager(
      [
        {
          ...createManagerDescriptor(),
          sessionLabel: 'Release Notes',
        },
      ],
      [createTestProfile('profile-a', 'Forge')],
    )

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-1' }))
    const receiptsMock = vi.fn(async () => ({}))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: receiptsMock,
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-device]',
      platform: 'ios',
      deviceName: 'iPhone',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    expect(sendMock).toHaveBeenCalledTimes(1)

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payload = (calls[0]?.[0] as Record<string, unknown> | undefined) ?? {}
    expect(calls[0]).toBeDefined()
    expect(payload.to).toBe('ExpoPushToken[test-device]')
    expect(payload.title).toBe('Forge / Release Notes')
    expect(payload.body).toBe('Finished — ready for you')
    const data = payload.data as Record<string, unknown>
    expect(data.reason).toBeUndefined()
    expect(data.eventId).toMatch(/^attention-/)
    expect(payload.data).toMatchObject({
      v: 1,
      type: 'attention',
      agentId: 'manager',
      sessionAgentId: 'manager',
      profileId: 'profile-a',
      route: '/profiles/profile-a/sessions/manager',
    })
  })

  it('uses the session title when the project/session title would be too long', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager(
      [
        {
          ...createManagerDescriptor(),
          sessionLabel: 'Mobile QA',
        },
      ],
      [createTestProfile('profile-a', 'A very long Forge project name that would crowd the notification title')],
    )

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-1' }))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-device]',
      platform: 'ios',
      deviceName: 'iPhone',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payload = (calls[0]?.[0] as Record<string, unknown> | undefined) ?? {}
    expect(payload.title).toBe('Mobile QA')
  })

  it('suppresses pushes for CLI-originated sessions when notification settings mute them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([
      createManagerDescriptor('profile-a', 'manager', undefined),
    ])
    const descriptor = manager.getAgent('manager')!
    descriptor.cli = { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-05-12T00:00:00.000Z' }

    const notificationSettingsService = new NotificationSettingsService({ dataDir })
    await notificationSettingsService.load()
    await notificationSettingsService.update({ muteCliOriginatedNotifications: true })

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-muted-1' }))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      notificationSettingsService,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-device]',
      platform: 'ios',
      deviceName: 'iPhone',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await flushAsync()
    await service.stop()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('suppresses push notifications when the session is actively viewed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-1' }))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: (sessionAgentId) => sessionAgentId === 'manager',
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-device]',
      platform: 'android',
      deviceName: 'Pixel',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await flushAsync()
    await service.stop()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('suppresses push notifications for cortex review sessions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor('cortex', 'review-run', 'cortex_review')])

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-1' }))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-device]',
      platform: 'ios',
      deviceName: 'Review Phone',
    })

    await service.start()
    emitAttention(manager, 'review-run')

    await flushAsync()
    await service.stop()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('retries transient send failures and disables DeviceNotRegistered tokens', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])

    const sendMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, error: 'temporary outage' })
      .mockResolvedValueOnce({
        ok: false,
        retryable: false,
        error: 'DeviceNotRegistered',
        errorCode: 'DeviceNotRegistered',
      })

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      sendRetryBackoffMs: [1, 1],
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[retry-device]',
      platform: 'ios',
      deviceName: 'Retry Phone',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await flushAsync()
    await waitForCondition(() => sendMock.mock.calls.length === 2)

    const devicesPath = getSharedMobileDevicesPath(dataDir)
    await waitForAsyncCondition(async () => {
      try {
        const devicesPayload = JSON.parse(await readFile(devicesPath, 'utf8')) as {
          devices: Array<{ token: string; enabled: boolean; disabledReason?: string }>
        }
        const stored = devicesPayload.devices.find((device) => device.token === 'ExpoPushToken[retry-device]')
        return stored?.enabled === false && stored?.disabledReason === 'DeviceNotRegistered'
      } catch {
        return false
      }
    })

    await service.stop()

    expect(sendMock).toHaveBeenCalledTimes(2)

    const devicesPayload = JSON.parse(await readFile(devicesPath, 'utf8')) as {
      devices: Array<{ token: string; enabled: boolean; disabledReason?: string }>
    }

    const stored = devicesPayload.devices.find((device) => device.token === 'ExpoPushToken[retry-device]')
    expect(stored?.enabled).toBe(false)
    expect(stored?.disabledReason).toBe('DeviceNotRegistered')
  })

  it('disables tokens when Expo receipts report DeviceNotRegistered', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'receipt-ticket-1' }))
    const receiptsMock = vi.fn(async () => ({
      'receipt-ticket-1': {
        status: 'error',
        details: {
          error: 'DeviceNotRegistered',
        },
      },
    }))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: receiptsMock,
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[receipt-device]',
      platform: 'ios',
      deviceName: 'Receipt Phone',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await (service as any).pollReceipts()
    await service.stop()

    expect(receiptsMock).toHaveBeenCalledWith(['receipt-ticket-1'])

    const devicesPath = getSharedMobileDevicesPath(dataDir)
    const devicesPayload = JSON.parse(await readFile(devicesPath, 'utf8')) as {
      devices: Array<{ token: string; enabled: boolean; disabledReason?: string }>
    }

    const stored = devicesPayload.devices.find((device) => device.token === 'ExpoPushToken[receipt-device]')
    expect(stored?.enabled).toBe(false)
    expect(stored?.disabledReason).toBe('DeviceNotRegistered')
  })

  it('persists client origin identity and echoes it per device without inventing a sender origin or URLs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager(
      [createManagerDescriptor('profile-a', 'manager')],
      [createTestProfile('profile-a', 'Forge')],
    )
    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-origin-1' }))

    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    const first = await service.registerDevice({
      token: 'ExpoPushToken[origin-a]',
      platform: 'ios',
      deviceName: 'Phone A',
      originId: 'server-a',
    })
    expect(first.originId).toBe('server-a')

    const reloadedWithoutOrigin = await service.registerDevice({
      token: 'ExpoPushToken[origin-a]',
      platform: 'ios',
      deviceName: 'Phone A',
    })
    expect(reloadedWithoutOrigin.originId).toBe('server-a')

    await service.registerDevice({
      token: 'ExpoPushToken[origin-b]',
      platform: 'android',
      deviceName: 'Phone B',
      originId: 'server-b',
    })

    await service.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 2)
    await service.stop()

    const payloads = sendMock.mock.calls.map((call) => call[0] as Record<string, unknown>)
    const byToken = new Map(payloads.map((payload) => [payload.to, payload]))
    const dataA = byToken.get('ExpoPushToken[origin-a]')?.data as Record<string, unknown>
    const dataB = byToken.get('ExpoPushToken[origin-b]')?.data as Record<string, unknown>

    expect(dataA).toMatchObject({
      v: 1,
      type: 'attention',
      agentId: 'manager',
      sessionAgentId: 'manager',
      profileId: 'profile-a',
      originId: 'server-a',
    })
    expect(dataB).toMatchObject({
      originId: 'server-b',
      sessionAgentId: 'manager',
      profileId: 'profile-a',
    })
    expect(dataA.eventId).toEqual(expect.any(String))
    expect(dataA.eventId).toBe(dataB.eventId)
    expect(JSON.stringify(dataA)).not.toMatch(/https?:\/\//)
    expect(byToken.get('ExpoPushToken[origin-a]')?.channelId).toBe('agent-updates')

    const devicesPath = getSharedMobileDevicesPath(dataDir)
    const stored = JSON.parse(await readFile(devicesPath, 'utf8')) as {
      devices: Array<{ token: string; originId?: string }>
    }
    expect(stored.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: 'ExpoPushToken[origin-a]', originId: 'server-a' }),
        expect.objectContaining({ token: 'ExpoPushToken[origin-b]', originId: 'server-b' }),
      ]),
    )
  })

  it('reloads persisted origin records after restart and keeps legacy records fail-closed without origin', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-restart-1' }))

    const firstService = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })
    await firstService.registerDevice({
      token: 'ExpoPushToken[persisted-origin]',
      platform: 'ios',
      deviceName: 'Persisted Phone',
      originId: 'server-persisted',
    })
    await firstService.stop()

    const devicesPath = getSharedMobileDevicesPath(dataDir)
    const existing = JSON.parse(await readFile(devicesPath, 'utf8')) as {
      version: number
      updatedAt: string
      devices: Array<Record<string, unknown>>
    }
    existing.devices.push({
      token: 'ExpoPushToken[legacy-device]',
      platform: 'ios',
      deviceName: 'Legacy Phone',
      registeredAt: '2026-01-01T00:00:00.000Z',
      enabled: true,
    })
    await writeFile(devicesPath, JSON.stringify(existing), 'utf8')

    const restarted = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await restarted.start()
    emitAttention(manager, 'manager')

    await waitForCondition(() => sendMock.mock.calls.length === 2)
    await restarted.stop()

    const payloads = sendMock.mock.calls.map((call) => call[0] as Record<string, unknown>)
    const persisted = payloads.find((payload) => payload.to === 'ExpoPushToken[persisted-origin]')
    const legacy = payloads.find((payload) => payload.to === 'ExpoPushToken[legacy-device]')
    expect((persisted?.data as Record<string, unknown>).originId).toBe('server-persisted')
    expect((legacy?.data as Record<string, unknown>).originId).toBeUndefined()
  })

  it('echoes a registered origin on test pushes without requiring the client to resend it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-test-origin' }))
    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: sendMock,
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await service.registerDevice({
      token: 'ExpoPushToken[test-origin]',
      platform: 'ios',
      deviceName: 'Test Phone',
      originId: 'server-test',
    })
    const result = await service.sendTestNotification({
      token: 'ExpoPushToken[test-origin]',
    })
    await service.stop()

    expect(result.ok).toBe(true)
    const data = (sendMock.mock.calls[0]?.[0] as Record<string, unknown>).data as Record<string, unknown>
    expect(data).toMatchObject({ type: 'test', originId: 'server-test' })
    expect(JSON.stringify(data)).not.toMatch(/https?:\/\//)
  })

  it('rejects credential-bearing URL origin identities instead of storing them on the device record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])
    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: {
        send: vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-url' })),
        getReceipts: vi.fn(async () => ({})),
      } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })

    await expect(
      service.registerDevice({
        token: 'ExpoPushToken[url-origin]',
        platform: 'ios',
        deviceName: 'Phone',
        originId: 'http://user:secret@host.test',
      }),
    ).rejects.toThrow(/origin identity, not a URL/)
    await service.stop()
  })
})

describe('MobilePushService Needs-you trigger', () => {
  async function startService(manager: FakeSwarmManager) {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-attention-'))
    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket' }))
    const service = new MobilePushService({
      swarmManager: manager as unknown as SwarmManager,
      dataDir,
      expoPushClient: { send: sendMock, getReceipts: vi.fn(async () => ({})) } as unknown as ExpoPushClient,
      isSessionActive: () => false,
      receiptPollIntervalMs: 60_000,
    })
    await service.registerDevice({ token: 'ExpoPushToken[attention]', platform: 'android', deviceName: 'Phone' })
    await service.start()
    const sent = () => (sendMock.mock.calls as unknown as Array<[Record<string, any>]>).map(([payload]) => payload)
    return { service, sendMock, sent }
  }

  it('pushes each attention once, when it first appears, and never for still-visible ones', async () => {
    const manager = new FakeSwarmManager([
      createManagerDescriptor('profile-a', 'manager'),
      createManagerDescriptor('profile-a', 'other'),
    ])
    const { service, sendMock, sent } = await startService(manager)
    const first = attention('manager', 'work_settled', 'a-1')
    const second = attention('other', 'decision_waiting', 'b-1')

    emitAttentionSnapshot(manager, [first])
    await waitForCondition(() => sendMock.mock.calls.length === 1)
    emitAttentionSnapshot(manager, [first])
    emitAttentionSnapshot(manager, [first, second])
    await waitForCondition(() => sendMock.mock.calls.length === 2)
    // Dismissed, then a later work epoch raises a new occurrence for the same session.
    emitAttentionSnapshot(manager, [second])
    emitAttentionSnapshot(manager, [second, attention('manager', 'work_failed', 'a-2')])
    await waitForCondition(() => sendMock.mock.calls.length === 3)
    await flushAsync()
    await service.stop()

    expect(sent().map((payload) => payload.data.eventId)).toEqual(['a-1', 'b-1', 'a-2'])
    expect(sent().map((payload) => payload.data.sessionAgentId)).toEqual(['manager', 'other', 'manager'])
    expect(sent().map((payload) => payload.body)).toEqual([
      'Finished — ready for you',
      'Waiting on your decision',
      'Work failed — needs your attention',
    ])
  })

  it('treats attention already visible at startup as a baseline, not new notifications', async () => {
    const manager = new FakeSwarmManager([createManagerDescriptor('profile-a', 'manager')])
    const restored = attention('manager', 'awaiting_review', 'restored-1')
    manager.initialAttentions = [restored]
    const { service, sendMock, sent } = await startService(manager)

    emitAttentionSnapshot(manager, [restored])
    await flushAsync()
    expect(sendMock).not.toHaveBeenCalled()

    emitAttentionSnapshot(manager, [restored, attention('manager', 'plan_completed', 'fresh-1')])
    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()
    expect(sent()[0]?.data.eventId).toBe('fresh-1')
  })

  it('does not push for assistant messages, status changes or choice requests', async () => {
    const manager = new FakeSwarmManager([
      createManagerDescriptor('profile-a', 'manager'),
      createWorkerDescriptor('manager', 'worker-1'),
    ])
    const { service, sendMock } = await startService(manager)
    const timestamp = new Date().toISOString()

    manager.emit('conversation_message', {
      type: 'conversation_message', agentId: 'manager', role: 'assistant',
      text: 'done', timestamp, source: 'speak_to_user',
    })
    manager.emit('agent_status', { type: 'agent_status', agentId: 'manager', status: 'idle', pendingCount: 0 })
    manager.emit('agent_status', { type: 'agent_status', agentId: 'worker-1', status: 'error', pendingCount: 0 })
    manager.emit('choice_request', {
      type: 'choice_request', agentId: 'worker-1', choiceId: 'c-1', status: 'pending', timestamp,
      questions: [{ id: 'q-1', question: 'Keep going?' }],
    })
    await flushAsync()
    await flushAsync()
    await service.stop()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('stops pushing after stop()', async () => {
    const manager = new FakeSwarmManager([createManagerDescriptor('profile-a', 'manager')])
    const { service, sendMock } = await startService(manager)
    await service.stop()

    emitAttention(manager, 'manager')
    await flushAsync()

    expect(sendMock).not.toHaveBeenCalled()
  })
})
