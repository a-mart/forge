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
import {
  getCortexAutoReviewSettingsPath,
  getProfileScheduleFilePath,
} from '../swarm/data-paths.js'

describe('CortexAutoReviewSettingsService', () => {
  it('loads defaults on missing settings file and seeds the default schedule', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-auto-review-settings-'))
    const now = new Date('2026-03-27T00:00:00.000Z')
    const service = new CortexAutoReviewSettingsService({
      dataDir,
      now: () => now,
    })

    await service.load()

    expect(service.getSettings()).toEqual({
      enabled: true,
      intervalMinutes: 120,
      updatedAt: null,
    })

    await expect(access(getCortexAutoReviewSettingsPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' })

    const storedSchedules = JSON.parse(
      await readFile(getProfileScheduleFilePath(dataDir, 'cortex'), 'utf8'),
    ) as { schedules: Array<Record<string, unknown>> }

    expect(storedSchedules.schedules).toEqual([
      {
        id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
        name: 'Cortex Auto-Review',
        cron: '0 */2 * * *',
        message: 'Review all sessions that need attention',
        oneShot: false,
        timezone: 'UTC',
        createdAt: '2026-03-27T00:00:00.000Z',
        nextFireAt: '2026-03-27T02:00:00.000Z',
      },
    ])
  })

  it('persists updates, merges partial patches, and removes the managed schedule when disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-auto-review-settings-update-'))
    const now = new Date('2026-03-27T12:00:00.000Z')
    const service = new CortexAutoReviewSettingsService({
      dataDir,
      now: () => now,
    })

    await service.load()
    await service.update({ intervalMinutes: 240 })

    expect(service.getSettings()).toEqual({
      enabled: true,
      intervalMinutes: 240,
      updatedAt: '2026-03-27T12:00:00.000Z',
    })

    const storedSettings = JSON.parse(
      await readFile(getCortexAutoReviewSettingsPath(dataDir), 'utf8'),
    ) as Record<string, unknown>
    expect(storedSettings).toEqual({
      version: 1,
      enabled: true,
      intervalMinutes: 240,
      updatedAt: '2026-03-27T12:00:00.000Z',
    })

    const scheduleAfterIntervalUpdate = JSON.parse(
      await readFile(getProfileScheduleFilePath(dataDir, 'cortex'), 'utf8'),
    ) as { schedules: Array<Record<string, unknown>> }
    expect(scheduleAfterIntervalUpdate.schedules).toHaveLength(1)
    expect(scheduleAfterIntervalUpdate.schedules[0]).toMatchObject({
      id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
      cron: '0 */4 * * *',
      createdAt: '2026-03-27T12:00:00.000Z',
      nextFireAt: '2026-03-27T16:00:00.000Z',
    })

    await service.update({ enabled: false })

    expect(service.getSettings()).toEqual({
      enabled: false,
      intervalMinutes: 240,
      updatedAt: '2026-03-27T12:00:00.000Z',
    })

    const scheduleAfterDisable = JSON.parse(
      await readFile(getProfileScheduleFilePath(dataDir, 'cortex'), 'utf8'),
    ) as { schedules: Array<Record<string, unknown>> }
    expect(scheduleAfterDisable.schedules).toEqual([])
  })

  it('rejects invalid interval updates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-auto-review-settings-invalid-'))
    const service = new CortexAutoReviewSettingsService({ dataDir })

    await service.load()

    await expect(service.update({ intervalMinutes: 14 })).rejects.toBeInstanceOf(
      CortexAutoReviewSettingsValidationError,
    )
    await expect(service.update({ intervalMinutes: 1441 })).rejects.toBeInstanceOf(
      CortexAutoReviewSettingsValidationError,
    )
  })
})

describe('syncCortexAutoReviewSchedule', () => {
  it('preserves user schedules and leaves the managed schedule untouched when already in sync', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-auto-review-sync-idempotent-'))
    const schedulePath = getProfileScheduleFilePath(dataDir, 'cortex')
    const original = {
      version: 3,
      notes: 'keep-me',
      schedules: [
        {
          id: 'user-created',
          name: 'User schedule',
          cron: '0 9 * * *',
          message: 'Run the user task',
          oneShot: false,
          timezone: 'UTC',
          createdAt: '2026-03-26T00:00:00.000Z',
          nextFireAt: '2026-03-27T09:00:00.000Z',
        },
        {
          id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
          name: 'Cortex Auto-Review',
          cron: '0 */2 * * *',
          message: 'Review all sessions that need attention',
          oneShot: false,
          timezone: 'UTC',
          createdAt: '2026-03-25T00:00:00.000Z',
          nextFireAt: '2026-03-27T02:00:00.000Z',
          lastFiredAt: '2026-03-27T00:00:00.000Z',
        },
      ],
    }

    await mkdir(dirname(schedulePath), { recursive: true })
    await writeFile(schedulePath, `${JSON.stringify(original, null, 2)}\n`, 'utf8')

    await syncCortexAutoReviewSchedule({
      dataDir,
      settings: {
        enabled: true,
        intervalMinutes: 120,
        updatedAt: null,
      },
      now: () => new Date('2026-03-27T01:00:00.000Z'),
    })

    const stored = JSON.parse(await readFile(schedulePath, 'utf8')) as Record<string, unknown>
    expect(stored).toEqual(original)
  })

  it('updates only the managed schedule entry when the interval changes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-auto-review-sync-update-'))
    const schedulePath = getProfileScheduleFilePath(dataDir, 'cortex')
    const original = {
      schedules: [
        {
          id: 'user-created',
          name: 'User schedule',
          cron: '0 9 * * *',
          message: 'Run the user task',
          oneShot: false,
          timezone: 'UTC',
          createdAt: '2026-03-26T00:00:00.000Z',
          nextFireAt: '2026-03-27T09:00:00.000Z',
        },
        {
          id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
          name: 'Old name',
          cron: '0 */2 * * *',
          message: 'Old message',
          oneShot: true,
          timezone: 'America/Chicago',
          createdAt: '2026-03-25T00:00:00.000Z',
          nextFireAt: '2026-03-27T02:00:00.000Z',
          lastFiredAt: '2026-03-27T00:00:00.000Z',
          custom: 'keep-me',
        },
      ],
    }

    await mkdir(dirname(schedulePath), { recursive: true })
    await writeFile(schedulePath, `${JSON.stringify(original, null, 2)}\n`, 'utf8')

    await syncCortexAutoReviewSchedule({
      dataDir,
      settings: {
        enabled: true,
        intervalMinutes: 480,
        updatedAt: null,
      },
      now: () => new Date('2026-03-27T01:00:00.000Z'),
    })

    const stored = JSON.parse(await readFile(schedulePath, 'utf8')) as {
      schedules: Array<Record<string, unknown>>
    }
    expect(stored.schedules).toHaveLength(2)
    expect(stored.schedules[0]).toEqual(original.schedules[0])
    expect(stored.schedules[1]).toEqual({
      id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
      name: 'Cortex Auto-Review',
      cron: '0 */8 * * *',
      message: 'Review all sessions that need attention',
      oneShot: false,
      timezone: 'UTC',
      createdAt: '2026-03-25T00:00:00.000Z',
      nextFireAt: '2026-03-27T08:00:00.000Z',
      lastFiredAt: '2026-03-27T00:00:00.000Z',
      custom: 'keep-me',
    })
  })
})

describe('cronExpressionForIntervalMinutes', () => {
  it('maps supported interval values to cron expressions', () => {
    expect(cronExpressionForIntervalMinutes(15)).toBe('*/15 * * * *')
    expect(cronExpressionForIntervalMinutes(30)).toBe('*/30 * * * *')
    expect(cronExpressionForIntervalMinutes(60)).toBe('0 */1 * * *')
    expect(cronExpressionForIntervalMinutes(120)).toBe('0 */2 * * *')
    expect(cronExpressionForIntervalMinutes(1440)).toBe('0 0 * * *')
  })
})
