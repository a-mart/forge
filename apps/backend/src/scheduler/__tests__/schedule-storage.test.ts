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

async function runScheduleCli(args: string[], dataDir: string) {
  return execFile(process.execPath, [scheduleCliPath, ...args], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..'),
    env: {
      ...process.env,
      SWARM_DATA_DIR: dataDir,
    },
  })
}

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

    await runScheduleCli(
      [
        'add',
        '--manager',
        'mobile-app',
        '--session',
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
      dataDir,
    )

    const expectedScheduleFile = join(dataDir, 'profiles', 'middleman-project', 'schedules', 'schedules.json')
    const bogusScheduleFile = join(dataDir, 'profiles', 'mobile-app', 'schedules', 'schedules.json')

    const raw = await readFile(expectedScheduleFile, 'utf8')
    const parsed = JSON.parse(raw) as {
      schedules?: Array<{
        sessionId?: string
        name?: string
        message?: string
      }>
    }

    expect(parsed.schedules).toHaveLength(1)
    expect(parsed.schedules?.[0]).toMatchObject({
      sessionId: 'mobile-app',
      name: 'Mobile app progress check-in',
      message: 'Check mobile app progress',
    })

    await expect(access(bogusScheduleFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cron scheduling CLI rejects sessions from a different profile', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedule-cli-invalid-profile-'))
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
            {
              agentId: 'other-profile--s2',
              role: 'manager',
              managerId: 'other-profile--s2',
              profileId: 'other-profile',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    await expect(
      runScheduleCli(
        [
          'add',
          '--manager',
          'mobile-app',
          '--session',
          'other-profile--s2',
          '--name',
          'Invalid schedule',
          '--cron',
          '0 */2 * * *',
          '--message',
          'Should fail',
          '--timezone',
          'UTC',
        ],
        dataDir,
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('belongs to profile other-profile, expected profile middleman-project'),
    })
  })

  it('cron scheduling CLI rejects non-manager sessions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'swarm-schedule-cli-invalid-role-'))
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
            {
              agentId: 'worker-a',
              role: 'worker',
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

    await expect(
      runScheduleCli(
        [
          'add',
          '--manager',
          'mobile-app',
          '--session',
          'worker-a',
          '--name',
          'Invalid worker schedule',
          '--cron',
          '0 */2 * * *',
          '--message',
          'Should fail',
          '--timezone',
          'UTC',
        ],
        dataDir,
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('target must be a manager session'),
    })
  })
})
