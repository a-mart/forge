import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSharedSlackConfigPath,
  getSlackConfigPath,
} from '../integrations/slack/slack-config.js'
import {
  getSharedTelegramConfigPath,
  getTelegramConfigPath,
} from '../integrations/telegram/telegram-config.js'
import { SHARED_INTEGRATION_MANAGER_ID } from '../integrations/shared-config.js'

const mockState = vi.hoisted(() => ({
  slackInstances: [] as any[],
  telegramInstances: [] as any[],
}))

vi.mock('../integrations/slack/slack-integration.js', () => ({
  SlackIntegrationService: class MockSlackIntegrationService extends EventEmitter {
    readonly managerId: string
    readonly start = vi.fn(async () => undefined)
    readonly stop = vi.fn(async () => undefined)

    constructor(options: { managerId: string }) {
      super()
      this.managerId = options.managerId
      mockState.slackInstances.push(this)
    }

    getStatus(): Record<string, unknown> {
      return {
        type: 'slack_status',
        managerId: this.managerId,
        integrationProfileId: `slack:${this.managerId}`,
        state: 'disabled',
        enabled: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        message: 'Slack integration disabled',
      }
    }

    getMaskedConfig(): Record<string, unknown> {
      return {
        profileId: `slack:${this.managerId}`,
        enabled: false,
      }
    }

    async updateConfig(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async disable(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async testConnection(): Promise<{ ok: boolean }> {
      return { ok: true }
    }

    async listChannels(): Promise<Array<{ id: string; name: string }>> {
      return [{ id: 'C123', name: 'alerts' }]
    }
  },
}))

vi.mock('../integrations/telegram/telegram-integration.js', () => ({
  TelegramIntegrationService: class MockTelegramIntegrationService extends EventEmitter {
    readonly managerId: string
    readonly start = vi.fn(async () => undefined)
    readonly stop = vi.fn(async () => undefined)

    constructor(options: { managerId: string }) {
      super()
      this.managerId = options.managerId
      mockState.telegramInstances.push(this)
    }

    getStatus(): Record<string, unknown> {
      return {
        type: 'telegram_status',
        managerId: this.managerId,
        integrationProfileId: `telegram:${this.managerId}`,
        state: 'disabled',
        enabled: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        message: 'Telegram integration disabled',
      }
    }

    getMaskedConfig(): Record<string, unknown> {
      return {
        profileId: `telegram:${this.managerId}`,
        enabled: false,
      }
    }

    async updateConfig(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async disable(): Promise<{ config: Record<string, unknown>; status: Record<string, unknown> }> {
      return {
        config: this.getMaskedConfig(),
        status: this.getStatus(),
      }
    }

    async testConnection(): Promise<{ ok: boolean }> {
      return { ok: true }
    }
  },
}))

import { IntegrationRegistryService } from '../integrations/registry.js'

interface FakeManagerOptions {
  configuredManagerId?: string
  listedManagerIds?: string[]
}

function createFakeSwarmManager(options: FakeManagerOptions = {}): {
  getConfig: () => { managerId?: string }
  listAgents: () => Array<{ agentId: string; role: 'manager' }>
} {
  const listedManagerIds = options.listedManagerIds ?? []

  return {
    getConfig: () => ({
      managerId: options.configuredManagerId,
    }),
    listAgents: () =>
      listedManagerIds.map((managerId) => ({
        agentId: managerId,
        role: 'manager',
      })),
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

afterEach(() => {
  mockState.slackInstances.length = 0
  mockState.telegramInstances.length = 0
})

describe('IntegrationRegistryService', () => {
  it('starts manager-scoped integration profiles for configured managers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'primary-manager',
        listedManagerIds: ['primary-manager'],
      }) as any,
      dataDir,
    })

    await registry.start()

    expect(mockState.slackInstances.map((instance) => instance.managerId)).toEqual(['primary-manager'])
    expect(mockState.telegramInstances.map((instance) => instance.managerId)).toEqual(['primary-manager'])

    await registry.stop()

    expect(mockState.slackInstances[0]?.stop).toHaveBeenCalledTimes(1)
    expect(mockState.telegramInstances[0]?.stop).toHaveBeenCalledTimes(1)
  })

  it('discovers managers from config, in-memory descriptors, and on-disk profiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))
    await writeJsonFile(getSlackConfigPath(dataDir, 'disk-manager'), {})

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'configured-manager',
        listedManagerIds: ['live-manager'],
      }) as any,
      dataDir,
    })

    await registry.start()

    const slackManagers = new Set(mockState.slackInstances.map((instance) => instance.managerId))
    const telegramManagers = new Set(mockState.telegramInstances.map((instance) => instance.managerId))

    expect(slackManagers).toEqual(new Set(['configured-manager', 'live-manager', 'disk-manager']))
    expect(telegramManagers).toEqual(new Set(['configured-manager', 'live-manager', 'disk-manager']))

    for (const instance of mockState.slackInstances) {
      expect(instance.start).toHaveBeenCalledTimes(1)
    }
    for (const instance of mockState.telegramInstances) {
      expect(instance.start).toHaveBeenCalledTimes(1)
    }
  })

  it('falls back to legacy manager integration directories when profiles are missing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))
    await writeJsonFile(
      join(dataDir, 'integrations', 'managers', 'legacy-manager', 'slack.json'),
      {},
    )

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager() as any,
      dataDir,
    })

    await registry.start()

    const slackManagers = new Set(mockState.slackInstances.map((instance) => instance.managerId))
    const telegramManagers = new Set(mockState.telegramInstances.map((instance) => instance.managerId))

    expect(slackManagers).toEqual(new Set(['legacy-manager']))
    expect(telegramManagers).toEqual(new Set(['legacy-manager']))
  })

  it('forwards status events from started profiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'manager',
      }) as any,
      dataDir,
    })

    await registry.start()

    const slackEvents: Array<Record<string, unknown>> = []
    const telegramEvents: Array<Record<string, unknown>> = []

    registry.on('slack_status', (event) => {
      slackEvents.push(event as Record<string, unknown>)
    })
    registry.on('telegram_status', (event) => {
      telegramEvents.push(event as Record<string, unknown>)
    })

    const slack = mockState.slackInstances.find((instance) => instance.managerId === 'manager')
    const telegram = mockState.telegramInstances.find((instance) => instance.managerId === 'manager')

    slack?.emit('slack_status', {
      type: 'slack_status',
      managerId: 'manager',
      state: 'connected',
    })
    telegram?.emit('telegram_status', {
      type: 'telegram_status',
      managerId: 'manager',
      state: 'connected',
    })

    expect(slackEvents).toContainEqual(
      expect.objectContaining({
        type: 'slack_status',
        managerId: 'manager',
        state: 'connected',
      }),
    )
    expect(telegramEvents).toContainEqual(
      expect.objectContaining({
        type: 'telegram_status',
        managerId: 'manager',
        state: 'connected',
      }),
    )
  })

  it('reads and writes shared integration config without creating runtime profiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'manager',
      }) as any,
      dataDir,
    })

    const slackUpdated = await registry.updateSlackConfig(SHARED_INTEGRATION_MANAGER_ID, {
      enabled: true,
      appToken: 'xapp-shared-token',
      botToken: 'xoxb-shared-token',
    })
    const telegramUpdated = await registry.updateTelegramConfig(SHARED_INTEGRATION_MANAGER_ID, {
      enabled: true,
      botToken: '123456:shared-token',
    })

    expect(mockState.slackInstances).toHaveLength(0)
    expect(mockState.telegramInstances).toHaveLength(0)

    expect(slackUpdated.config.enabled).toBe(true)
    expect(slackUpdated.status.managerId).toBe(SHARED_INTEGRATION_MANAGER_ID)
    expect(telegramUpdated.config.enabled).toBe(true)
    expect(telegramUpdated.status.managerId).toBe(SHARED_INTEGRATION_MANAGER_ID)

    const slackFile = JSON.parse(
      await readFile(getSharedSlackConfigPath(dataDir), 'utf8'),
    ) as { enabled?: boolean; appToken?: string; botToken?: string }
    expect(slackFile.enabled).toBe(true)
    expect(slackFile.appToken).toBe('xapp-shared-token')
    expect(slackFile.botToken).toBe('xoxb-shared-token')

    const telegramFile = JSON.parse(
      await readFile(getSharedTelegramConfigPath(dataDir), 'utf8'),
    ) as { enabled?: boolean; botToken?: string }
    expect(telegramFile.enabled).toBe(true)
    expect(telegramFile.botToken).toBe('123456:shared-token')

    const slackSnapshot = await registry.getSlackSnapshot(SHARED_INTEGRATION_MANAGER_ID)
    const telegramSnapshot = await registry.getTelegramSnapshot(SHARED_INTEGRATION_MANAGER_ID)

    expect(slackSnapshot.config.enabled).toBe(true)
    expect(telegramSnapshot.config.enabled).toBe(true)
  })
})
