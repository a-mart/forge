import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('dispatches unread notifications with contextual session titles and routing data', async () => {
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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'hello from manager',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    expect(sendMock).toHaveBeenCalledTimes(1)

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payload = (calls[0]?.[0] as Record<string, unknown> | undefined) ?? {}
    expect(calls[0]).toBeDefined()
    expect(payload.to).toBe('ExpoPushToken[test-device]')
    expect(payload.title).toBe('Forge / Release Notes')
    expect(payload.data).toMatchObject({
      v: 1,
      type: 'unread',
      reason: 'message',
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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'hello from manager',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payload = (calls[0]?.[0] as Record<string, unknown> | undefined) ?? {}
    expect(payload.title).toBe('Mobile QA')
  })

  it('sends unread pushes for projected assistant_output messages', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor('profile-a', 'manager', undefined)])
    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-projected-1' }))

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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'projected answer',
      timestamp: new Date().toISOString(),
      source: 'assistant_output',
      sourceContext: { channel: 'web' },
    })

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    expect(sendMock).toHaveBeenCalledTimes(1)
    const payload = sendMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload.body).toBe('projected answer')
    expect(payload.data).toMatchObject({ type: 'unread', reason: 'message', agentId: 'manager' })
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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'hello from manager',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

    await flushAsync()
    await service.stop()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('does not send error pushes for recoverable system error messages while the session keeps running', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([createManagerDescriptor()])

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-error-1' }))

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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'system',
      text: '⚠️ Worker reply failed: This operation was aborted. The manager may need to retry after checking provider auth, quotas, or rate limits.',
      timestamp: new Date().toISOString(),
      source: 'system',
    })

    await flushAsync()
    await service.stop()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends error pushes only for terminal manager failures, not worker error statuses', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([
      createManagerDescriptor('profile-a', 'manager'),
      createWorkerDescriptor('manager', 'worker-1'),
      {
        ...createManagerDescriptor('profile-a', 'errored-manager'),
        displayName: 'Errored Manager',
        status: 'error',
      },
    ])

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-status-1' }))

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
    manager.emit('agent_status', {
      type: 'agent_status',
      agentId: 'worker-1',
      status: 'error',
      pendingCount: 0,
    })
    manager.emit('agent_status', {
      type: 'agent_status',
      agentId: 'errored-manager',
      status: 'error',
      pendingCount: 0,
    })

    await waitForCondition(() => sendMock.mock.calls.length === 2)
    await service.stop()

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payloads = calls.map((call) => ((call[0] as Record<string, unknown> | undefined) ?? {}))
    const workerPayload = payloads.find((payload) => {
      const data = payload.data as Record<string, unknown> | undefined
      return data?.type === 'agent_status' && data?.agentId === 'worker-1'
    })
    const managerPayload = payloads.find((payload) => {
      const data = payload.data as Record<string, unknown> | undefined
      return data?.type === 'error' && data?.agentId === 'errored-manager'
    })

    expect(workerPayload).toBeDefined()
    expect(workerPayload?.data).toMatchObject({
      type: 'agent_status',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
    })
    expect(managerPayload).toBeDefined()
    expect(managerPayload?.data).toMatchObject({
      type: 'error',
      agentId: 'errored-manager',
      sessionAgentId: 'errored-manager',
    })
  })

  it('dispatches pending choice requests as question notifications routed to the owning session', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mobile-push-service-'))
    const manager = new FakeSwarmManager([
      createManagerDescriptor('profile-a', 'manager'),
      createWorkerDescriptor('manager', 'worker-1'),
    ])

    const sendMock = vi.fn(async () => ({ ok: true, retryable: false, ticketId: 'ticket-choice-1' }))

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
    manager.emit('choice_request', {
      type: 'choice_request',
      agentId: 'worker-1',
      choiceId: 'choice-123',
      status: 'pending',
      timestamp: new Date().toISOString(),
      questions: [
        {
          id: 'q-1',
          question: 'Should I keep the current retry window?',
        },
      ],
    })

    await waitForCondition(() => sendMock.mock.calls.length === 1)
    await service.stop()

    const calls = sendMock.mock.calls as unknown as Array<Array<unknown>>
    const payload = (calls[0]?.[0] as Record<string, unknown> | undefined) ?? {}

    expect(payload.to).toBe('ExpoPushToken[test-device]')
    expect(payload.title).toBe('Backend Specialist needs your answer')
    expect(payload.body).toBe('Should I keep the current retry window?')
    expect(payload.data).toMatchObject({
      v: 1,
      type: 'choice_request',
      reason: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      profileId: 'profile-a',
      route: '/profiles/profile-a/sessions/manager',
    })
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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'suppressed message',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'review-run',
      role: 'assistant',
      text: 'review update',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'retry path',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

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
    manager.emit('conversation_message', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'receipt path',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    })

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
})
