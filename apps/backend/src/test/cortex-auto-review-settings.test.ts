import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORTEX_AUTO_REVIEW_SCHEDULE_ID,
  CortexAutoReviewSettingsService,
  CortexAutoReviewSettingsValidationError,
  cronExpressionForIntervalMinutes,
  syncCortexAutoReviewSchedule,
} from '../swarm/cortex-auto-review-settings.js'
import { getCortexAutoReviewSettingsPath, getProfileScheduleFilePath } from '../swarm/data-paths.js'

describe('CortexAutoReviewSettingsService', () => {
  it('loads daily consolidation defaults and seeds the managed schedule', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-consolidation-settings-'))
    const service = new CortexAutoReviewSettingsService({
      dataDir,
      now: () => new Date('2026-03-27T00:00:00.000Z'),
    })

    await service.load()

    expect(service.getSettings()).toEqual({ enabled: true, intervalMinutes: 1440, updatedAt: null })
    await expect(access(getCortexAutoReviewSettingsPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })
    const stored = JSON.parse(await readFile(getProfileScheduleFilePath(dataDir, 'cortex'), 'utf8')) as { schedules: Array<Record<string, unknown>> }
    expect(stored.schedules).toEqual([
      expect.objectContaining({
        id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
        sessionId: 'cortex',
        name: 'Cortex Consolidation',
        cron: '0 0 * * *',
        message: 'Consolidate knowledge entries',
        nextFireAt: '2026-03-28T00:00:00.000Z',
      }),
    ])
  })

  it('persists enabled changes and removes the managed schedule when disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-consolidation-settings-update-'))
    const service = new CortexAutoReviewSettingsService({
      dataDir,
      now: () => new Date('2026-03-27T12:00:00.000Z'),
    })

    await service.load()
    await service.update({ enabled: false })

    expect(service.getSettings()).toEqual({
      enabled: false,
      intervalMinutes: 1440,
      updatedAt: '2026-03-27T12:00:00.000Z',
    })
    const storedSettings = JSON.parse(await readFile(getCortexAutoReviewSettingsPath(dataDir), 'utf8')) as Record<string, unknown>
    expect(storedSettings).toMatchObject({ version: 1, enabled: false, intervalMinutes: 1440 })
    const storedSchedules = JSON.parse(await readFile(getProfileScheduleFilePath(dataDir, 'cortex'), 'utf8')) as { schedules: unknown[] }
    expect(storedSchedules.schedules).toEqual([])
  })

  it('rejects non-daily intervals', async () => {
    const service = new CortexAutoReviewSettingsService({ dataDir: await mkdtemp(join(tmpdir(), 'cortex-consolidation-settings-invalid-')) })
    await service.load()
    await expect(service.update({ intervalMinutes: 120 })).rejects.toBeInstanceOf(CortexAutoReviewSettingsValidationError)
  })
})

describe('syncCortexAutoReviewSchedule', () => {
  it('preserves user schedules and updates only the managed daily consolidation entry', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-consolidation-sync-'))
    const schedulePath = getProfileScheduleFilePath(dataDir, 'cortex')
    await mkdir(dirname(schedulePath), { recursive: true })
    await writeFile(schedulePath, JSON.stringify({
      schedules: [
        { id: 'user-created', name: 'User schedule', cron: '0 9 * * *', message: 'Run user task' },
        { id: CORTEX_AUTO_REVIEW_SCHEDULE_ID, name: 'Old name', cron: '0 */2 * * *', message: 'Old message', createdAt: '2026-03-25T00:00:00.000Z' },
      ],
    }), 'utf8')

    await syncCortexAutoReviewSchedule({
      dataDir,
      settings: { enabled: true, intervalMinutes: 1440, updatedAt: null },
      now: () => new Date('2026-03-27T01:00:00.000Z'),
    })

    const stored = JSON.parse(await readFile(schedulePath, 'utf8')) as { schedules: Array<Record<string, unknown>> }
    expect(stored.schedules[0]).toMatchObject({ id: 'user-created' })
    expect(stored.schedules[1]).toMatchObject({
      id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
      name: 'Cortex Consolidation',
      cron: '0 0 * * *',
      message: 'Consolidate knowledge entries',
      nextFireAt: '2026-03-28T00:00:00.000Z',
    })
  })
})

describe('cronExpressionForIntervalMinutes', () => {
  it('maps the daily consolidation cadence', () => {
    expect(cronExpressionForIntervalMinutes(1440)).toBe('0 0 * * *')
  })
})
