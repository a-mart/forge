import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getScheduleFilePath } from '../../../../scheduler/schedule-storage.js'
import { getAvailablePort } from '../../../../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

describe('SwarmWebSocketServer', () => {
  it('returns schedules through GET /api/managers/:managerId/schedules', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    await mkdir(dirname(config.paths.schedulesFile!), { recursive: true })

    await writeFile(
      config.paths.schedulesFile!,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'daily-standup',
              sessionId: 'manager',
              name: 'Daily standup',
              cron: '0 9 * * *',
              message: 'Post standup summary to the team.',
              oneShot: false,
              timezone: 'America/Los_Angeles',
              createdAt: '2026-02-20T08:00:00.000Z',
              nextFireAt: '2026-02-21T17:00:00.000Z',
            },
            {
              id: '',
              name: 'invalid',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/managers/manager/schedules`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        schedules: Array<{
          id: string
          sessionId: string
          name: string
          cron: string
          message: string
          oneShot: boolean
          timezone: string
          createdAt: string
          nextFireAt: string
        }>
      }

      expect(payload.schedules).toEqual([
        {
          id: 'daily-standup',
          sessionId: 'manager',
          name: 'Daily standup',
          cron: '0 9 * * *',
          message: 'Post standup summary to the team.',
          oneShot: false,
          timezone: 'America/Los_Angeles',
          createdAt: '2026-02-20T08:00:00.000Z',
          nextFireAt: '2026-02-21T17:00:00.000Z',
        },
      ])
    } finally {
      await server.stop()
    }
  })

  it('returns manager-scoped schedules through GET /api/managers/:managerId/schedules', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const secondaryManager = await manager.createManager('manager', {
      name: 'release-manager',
      cwd: config.paths.rootDir,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()
    const secondaryManagerScheduleFile = getScheduleFilePath(config.paths.dataDir, secondaryManager.agentId)
    await mkdir(dirname(secondaryManagerScheduleFile), { recursive: true })

    await writeFile(
      secondaryManagerScheduleFile,
      JSON.stringify(
        {
          schedules: [
            {
              id: 'weekly-check',
              sessionId: secondaryManager.agentId,
              name: 'Weekly release check',
              cron: '0 10 * * 1',
              message: 'Review release readiness.',
              oneShot: false,
              timezone: 'America/Los_Angeles',
              createdAt: '2026-02-20T08:00:00.000Z',
              nextFireAt: '2026-02-23T18:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/${encodeURIComponent(secondaryManager.agentId)}/schedules`,
      )
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        schedules: Array<{
          id: string
          sessionId: string
          name: string
          cron: string
          message: string
          oneShot: boolean
          timezone: string
          createdAt: string
          nextFireAt: string
        }>
      }

      expect(payload.schedules).toEqual([
        {
          id: 'weekly-check',
          sessionId: secondaryManager.agentId,
          name: 'Weekly release check',
          cron: '0 10 * * 1',
          message: 'Review release readiness.',
          oneShot: false,
          timezone: 'America/Los_Angeles',
          createdAt: '2026-02-20T08:00:00.000Z',
          nextFireAt: '2026-02-23T18:00:00.000Z',
        },
      ])
    } finally {
      await server.stop()
    }
  })

  it('returns 404 for unknown manager schedule routes', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(
        `http://${config.host}:${config.port}/api/managers/unknown-manager/schedules`,
      )
      expect(response.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('returns an empty schedule list when the manager schedule file is missing', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/managers/manager/schedules`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as { schedules: unknown[] }
      expect(payload.schedules).toEqual([])
    } finally {
      await server.stop()
    }
  })

})
