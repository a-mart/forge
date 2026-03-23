import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSharedTelegramConfigPath,
  getTelegramConfigPath,
} from '../integrations/telegram/telegram-config.js'
import { SHARED_INTEGRATION_MANAGER_ID } from '../integrations/shared-config.js'

const mockState = vi.hoisted(() => ({
  telegramInstances: [] as any[],
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
  getAgent: (agentId: string) => { agentId: string; role: 'manager' } | undefined
  listAgents: () => Array<{ agentId: string; role: 'manager' }>
} {
  const listedManagerIds = options.listedManagerIds ?? []
  const listedDescriptors = listedManagerIds.map((managerId) => ({
    agentId: managerId,
    role: 'manager' as const,
  }))

  return {
    getConfig: () => ({
      managerId: options.configuredManagerId,
    }),
    getAgent: (agentId) => listedDescriptors.find((descriptor) => descriptor.agentId === agentId),
    listAgents: () => listedDescriptors,
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

afterEach(() => {
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

    expect(mockState.telegramInstances.map((instance) => instance.managerId)).toEqual(['primary-manager'])

    await registry.stop()

    expect(mockState.telegramInstances[0]?.stop).toHaveBeenCalledTimes(1)
  })

  it('discovers managers from config, in-memory descriptors, and on-disk profiles', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))
    await writeJsonFile(getTelegramConfigPath(dataDir, 'disk-manager'), {})

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager({
        configuredManagerId: 'configured-manager',
        listedManagerIds: ['live-manager'],
      }) as any,
      dataDir,
    })

    await registry.start()

    const telegramManagers = new Set(mockState.telegramInstances.map((instance) => instance.managerId))

    expect(telegramManagers).toEqual(new Set(['configured-manager', 'live-manager', 'disk-manager']))

    for (const instance of mockState.telegramInstances) {
      expect(instance.start).toHaveBeenCalledTimes(1)
    }
  })

  it('falls back to legacy manager integration directories when profiles are missing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-registry-test-'))
    await writeJsonFile(
      join(dataDir, 'integrations', 'managers', 'legacy-manager', 'telegram.json'),
      {},
    )

    const registry = new IntegrationRegistryService({
      swarmManager: createFakeSwarmManager() as any,
      dataDir,
    })

    await registry.start()

    const telegramManagers = new Set(mockState.telegramInstances.map((instance) => instance.managerId))
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

    const telegramEvents: Array<Record<string, unknown>> = []

    registry.on('telegram_status', (event) => {
      telegramEvents.push(event as Record<string, unknown>)
    })

    const telegram = mockState.telegramInstances.find((instance) => instance.managerId === 'manager')

    telegram?.emit('telegram_status', {
      type: 'telegram_status',
      managerId: 'manager',
      state: 'connected',
    })

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

    const telegramUpdated = await registry.updateTelegramConfig(SHARED_INTEGRATION_MANAGER_ID, {
      enabled: true,
      botToken: '123456:shared-token',
    })

    expect(mockState.telegramInstances).toHaveLength(0)

    expect(telegramUpdated.config.enabled).toBe(true)
    expect(telegramUpdated.status.managerId).toBe(SHARED_INTEGRATION_MANAGER_ID)

    const telegramFile = JSON.parse(
      await readFile(getSharedTelegramConfigPath(dataDir), 'utf8'),
    ) as { enabled?: boolean; botToken?: string }
    expect(telegramFile.enabled).toBe(true)
    expect(telegramFile.botToken).toBe('123456:shared-token')

    const telegramSnapshot = await registry.getTelegramSnapshot(SHARED_INTEGRATION_MANAGER_ID)
    expect(telegramSnapshot.config.enabled).toBe(true)
  })
})
