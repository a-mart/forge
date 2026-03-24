import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { getScheduleFilePath } from '../schedule-storage.js'

const execFile = promisify(execFileCallback)
const scheduleCliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'swarm',
  'skills',
  'builtins',
  'cron-scheduling',
  'schedule.js',
)

describe('schedule-storage', () => {
  it('stores schedules under profile-scoped files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedules-path-'))
    expect(getScheduleFilePath(dataDir, 'release-manager')).toBe(
      join(dataDir, 'profiles', 'release-manager', 'schedules', 'schedules.json'),
    )
  })

  it('cron scheduling CLI resolves a session managerId to the owning profile schedule path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedule-cli-'))
    const agentsStorePath = join(dataDir, 'swarm', 'agents.json')
    await mkdir(dirname(agentsStorePath), { recursive: true })
    await writeFile(
      agentsStorePath,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'mobile-app',
              role: 'manager',
              managerId: 'mobile-app',
              profileId: 'middleman-project',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    await execFile(
      process.execPath,
      [
        scheduleCliPath,
        'add',
        '--manager',
        'mobile-app',
        '--name',
        'Mobile app progress check-in',
        '--cron',
        '0 */2 * * *',
        '--message',
        'Check mobile app progress',
        '--timezone',
        'UTC',
      ],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
        env: {
          ...process.env,
          SWARM_DATA_DIR: dataDir,
        },
      },
    )

    const expectedScheduleFile = join(dataDir, 'profiles', 'middleman-project', 'schedules', 'schedules.json')
    const bogusScheduleFile = join(dataDir, 'profiles', 'mobile-app', 'schedules', 'schedules.json')

    const raw = await readFile(expectedScheduleFile, 'utf8')
    const parsed = JSON.parse(raw) as {
      schedules?: Array<{
        name?: string
        message?: string
      }>
    }

    expect(parsed.schedules).toHaveLength(1)
    expect(parsed.schedules?.[0]).toMatchObject({
      name: 'Mobile app progress check-in',
      message: 'Check mobile app progress',
    })

    await expect(access(bogusScheduleFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
