import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CronSchedulerService, type ScheduledTask } from '../scheduler/cron-scheduler-service.js'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import type { AgentDescriptor } from '../swarm/types.js'

interface SchedulesPayload {
  schedules: ScheduledTask[]
}

function createSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-1',
    sessionId: 'manager',
    name: 'Daily summary',
    cron: '* * * * *',
    message: 'Summarize unresolved issues from the board.',
    oneShot: false,
    timezone: 'UTC',
    createdAt: '2026-01-01T00:00:00.000Z',
    nextFireAt: '2025-12-31T23:59:00.000Z',
    ...overrides,
  }
}

function createSessionDescriptor(
  overrides: Partial<Pick<AgentDescriptor, 'agentId' | 'status' | 'role' | 'profileId'>> = {},
): AgentDescriptor {
  return {
    agentId: overrides.agentId ?? 'manager',
    managerId: overrides.agentId ?? 'manager',
    role: overrides.role ?? 'manager',
    displayName: overrides.agentId ?? 'manager',
    model: {
      provider: 'openai',
      modelId: 'test-model',
      thinkingLevel: 'medium',
    },
    status: overrides.status ?? 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    profileId: overrides.profileId ?? 'manager',
    cwd: '/tmp',
    sessionFile: '/tmp/session.jsonl',
  }
}

function createSwarmManagerMock(options: {
  handleUserMessage?: ReturnType<typeof vi.fn>
  getAgent?: ReturnType<typeof vi.fn>
} = {}): SwarmManager {
  return {
    handleUserMessage: options.handleUserMessage ?? vi.fn(async () => undefined),
    getAgent: options.getAgent ?? vi.fn((agentId: string) => createSessionDescriptor({ agentId })),
  } as unknown as SwarmManager
}

async function readSchedulesFile(path: string): Promise<SchedulesPayload> {
  return JSON.parse(await readFile(path, 'utf8')) as SchedulesPayload
}

async function writeSchedulesFile(path: string, payload: { schedules: Array<ScheduledTask | Omit<ScheduledTask, 'sessionId'>> }): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
}

describe('CronSchedulerService', () => {
  it('fires due one-shot schedules on startup and removes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    await writeSchedulesFile(schedulesFile, {
      schedules: [
        createSchedule({
          oneShot: true,
          nextFireAt: dueAt,
        }),
      ],
    })

    const handleUserMessage = vi.fn(async () => undefined)

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({ handleUserMessage }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(1)

    const firstCall = handleUserMessage.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [message, options] = firstCall as unknown as [
      string,
      { targetAgentId: string; sourceContext: { channel: string } },
    ]
    expect(message).toContain('[Scheduled Task: Daily summary]')
    expect(message).toContain('"scheduleId":"schedule-1"')
    expect(message).toContain('"sessionId":"manager"')
    expect(options).toEqual({
      targetAgentId: 'manager',
      sourceContext: { channel: 'web' },
    })

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules).toEqual([])
  })

  it('advances recurring schedules and records lastFiredAt after a successful dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    await writeSchedulesFile(schedulesFile, {
      schedules: [
        createSchedule({
          sessionId: 'manager--s2',
          oneShot: false,
          nextFireAt: dueAt,
        }),
      ],
    })

    const handleUserMessage = vi.fn(async () => undefined)

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({
        handleUserMessage,
        getAgent: vi.fn((agentId: string) => createSessionDescriptor({ agentId })),
      }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(1)
    expect(handleUserMessage.mock.calls[0]?.[1]).toEqual({
      targetAgentId: 'manager--s2',
      sourceContext: { channel: 'web' },
    })

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules).toHaveLength(1)
    expect(stored.schedules[0]?.lastFiredAt).toBe(dueAt)
    expect(Date.parse(stored.schedules[0]?.nextFireAt ?? '')).toBeGreaterThan(Date.parse(dueAt))
  })

  it('does not mutate schedule state when dispatch fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    const original = createSchedule({
      sessionId: 'manager--s2',
      oneShot: false,
      nextFireAt: dueAt,
    })

    await writeSchedulesFile(schedulesFile, {
      schedules: [original],
    })

    const handleUserMessage = vi.fn(async () => {
      throw new Error('manager unavailable')
    })

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({
        handleUserMessage,
        getAgent: vi.fn((agentId: string) => createSessionDescriptor({ agentId })),
      }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(1)

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules).toEqual([original])
  })

  it('suppresses duplicate recurring occurrences already marked as fired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    await writeSchedulesFile(schedulesFile, {
      schedules: [
        createSchedule({
          oneShot: false,
          nextFireAt: dueAt,
          lastFiredAt: dueAt,
        }),
      ],
    })

    const handleUserMessage = vi.fn(async () => undefined)

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({ handleUserMessage }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(0)

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules).toHaveLength(1)
    expect(stored.schedules[0]?.lastFiredAt).toBe(dueAt)
    expect(Date.parse(stored.schedules[0]?.nextFireAt ?? '')).toBeGreaterThan(Date.parse(dueAt))
  })

  it('normalizes legacy schedules without sessionId onto the profile root session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()

    await writeSchedulesFile(schedulesFile, {
      schedules: [
        {
          id: 'legacy-schedule',
          name: 'Legacy schedule',
          cron: '* * * * *',
          message: 'Run the old task.',
          oneShot: false,
          timezone: 'UTC',
          createdAt: '2026-01-01T00:00:00.000Z',
          nextFireAt: dueAt,
        },
      ],
    })

    const handleUserMessage = vi.fn(async () => undefined)

    const service = new CronSchedulerService({
      swarmManager: createSwarmManagerMock({ handleUserMessage }),
      schedulesFile,
      managerId: 'manager',
      now: () => now,
      pollIntervalMs: 5_000,
    })

    await service.start()
    await service.stop()

    expect(handleUserMessage).toHaveBeenCalledTimes(1)
    expect(handleUserMessage.mock.calls[0]?.[1]).toEqual({
      targetAgentId: 'manager',
      sourceContext: { channel: 'web' },
    })

    const stored = await readSchedulesFile(schedulesFile)
    expect(stored.schedules[0]?.sessionId).toBe('manager')
  })

  it('skips due schedules when the target session is missing, cross-profile, or not running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-cron-test-'))
    const schedulesFile = join(root, 'schedules', 'manager.json')
    const now = new Date('2026-01-01T00:00:00.000Z')
    const dueAt = new Date('2025-12-31T23:59:00.000Z').toISOString()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await writeSchedulesFile(schedulesFile, {
      schedules: [
        createSchedule({ id: 'missing-session', sessionId: 'missing-session', nextFireAt: dueAt }),
        createSchedule({ id: 'wrong-profile-session', sessionId: 'wrong-profile-session', nextFireAt: dueAt }),
        createSchedule({ id: 'stopped-session', sessionId: 'stopped-session', nextFireAt: dueAt }),
      ],
    })

    const handleUserMessage = vi.fn(async () => undefined)
    const getAgent = vi.fn((agentId: string) => {
      if (agentId === 'wrong-profile-session') {
        return createSessionDescriptor({ agentId, profileId: 'other-profile' })
      }
      if (agentId === 'stopped-session') {
        return createSessionDescriptor({ agentId, status: 'stopped' })
      }
      return undefined
    })

    try {
      const service = new CronSchedulerService({
        swarmManager: createSwarmManagerMock({ handleUserMessage, getAgent }),
        schedulesFile,
        managerId: 'manager',
        now: () => now,
        pollIntervalMs: 5_000,
      })

      await service.start()
      await service.stop()

      expect(handleUserMessage).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('target session missing-session does not exist'),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('target session wrong-profile-session belongs to profile other-profile'),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('target session stopped-session is not running'),
      )

      const stored = await readSchedulesFile(schedulesFile)
      expect(stored.schedules).toHaveLength(3)
      expect(Date.parse(stored.schedules[0]?.nextFireAt ?? '')).toBeGreaterThan(Date.parse(dueAt))
      expect(Date.parse(stored.schedules[1]?.nextFireAt ?? '')).toBeGreaterThan(Date.parse(dueAt))
      expect(Date.parse(stored.schedules[2]?.nextFireAt ?? '')).toBeGreaterThan(Date.parse(dueAt))
    } finally {
      warnSpy.mockRestore()
    }
  })
})
