import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PlaywrightSettingsService,
  PlaywrightSettingsValidationError,
} from '../playwright/playwright-settings-service.js'
import { getSharedPlaywrightDashboardSettingsPath } from '../swarm/data-paths.js'

describe('PlaywrightSettingsService', () => {
  it('loads defaults and persists validated updates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'playwright-settings-'))
    const service = new PlaywrightSettingsService({
      dataDir,
      now: () => new Date('2026-03-09T18:00:00.000Z'),
    })

    await service.load()
    expect(service.getPersisted()).toEqual({
      enabled: false,
      scanRoots: [],
      pollIntervalMs: 10_000,
      socketProbeTimeoutMs: 750,
      staleSessionThresholdMs: 3_600_000,
      updatedAt: null,
    })

    const scanRootA = join(tmpdir(), 'playwright-a')
    const scanRootB = join(tmpdir(), 'playwright-b')

    await service.update({
      enabled: true,
      scanRoots: [scanRootA, scanRootA, scanRootB],
      pollIntervalMs: 5_000,
      socketProbeTimeoutMs: 500,
      staleSessionThresholdMs: 120_000,
    })

    expect(service.getPersisted()).toEqual({
      enabled: true,
      scanRoots: [scanRootA, scanRootB],
      pollIntervalMs: 5_000,
      socketProbeTimeoutMs: 500,
      staleSessionThresholdMs: 120_000,
      updatedAt: '2026-03-09T18:00:00.000Z',
    })

    const stored = JSON.parse(
      await readFile(getSharedPlaywrightDashboardSettingsPath(dataDir), 'utf8'),
    ) as Record<string, unknown>

    expect(stored).toMatchObject({
      version: 1,
      enabled: true,
      scanRoots: [scanRootA, scanRootB],
      pollIntervalMs: 5_000,
      socketProbeTimeoutMs: 500,
      staleSessionThresholdMs: 120_000,
      updatedAt: '2026-03-09T18:00:00.000Z',
    })
  })

  it('rejects invalid updates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'playwright-settings-invalid-'))
    const service = new PlaywrightSettingsService({ dataDir })
    await service.load()

    await expect(
      service.update({
        scanRoots: ['relative/path'],
      }),
    ).rejects.toBeInstanceOf(PlaywrightSettingsValidationError)

    await expect(
      service.update({
        pollIntervalMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(PlaywrightSettingsValidationError)
  })
})
