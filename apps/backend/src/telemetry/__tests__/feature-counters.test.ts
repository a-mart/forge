import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectFeatureAdoption } from '../feature-counters.js'
import { getSessionTerminalsDir } from '../../swarm/data-paths.js'
import type { SwarmConfig } from '../../swarm/types.js'

async function writeSkill(baseDir: string, skillName: string) {
  const skillDir = join(baseDir, skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf8')
}

async function writeExtensionFile(baseDir: string, fileName: string) {
  await mkdir(baseDir, { recursive: true })
  await writeFile(join(baseDir, fileName), 'export default {}\n', 'utf8')
}

async function writeSpecialist(
  baseDir: string,
  fileName: string,
  options: { builtin?: boolean; enabled?: boolean } = {},
) {
  await mkdir(baseDir, { recursive: true })
  await writeFile(
    join(baseDir, fileName),
    [
      '---',
      'displayName: Example Specialist',
      'color: "#3b82f6"',
      `enabled: ${options.enabled === false ? 'false' : 'true'}`,
      'whenToUse: Use for tests.',
      'modelId: gpt-5.4',
      `builtin: ${options.builtin === true ? 'true' : 'false'}`,
      'pinned: false',
      'webSearch: false',
      '---',
      '',
      'You are a specialist used in telemetry tests.',
      '',
    ].join('\n'),
    'utf8',
  )
}

function createConfig(rootDir: string): SwarmConfig {
  return {
    paths: {
      rootDir,
    },
  } as SwarmConfig
}

describe('feature counters', () => {
  it('counts persisted project agents from raw agents registry shapes and exposes the clearer alias', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'feature-counters-project-agents-root-'))

    async function collectForAgents(agents: unknown[]) {
      const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-project-agents-data-'))
      await mkdir(join(dataDir, 'swarm'), { recursive: true })
      await writeFile(
        join(dataDir, 'swarm', 'agents.json'),
        JSON.stringify({ agents }),
        'utf8',
      )

      return collectFeatureAdoption(dataDir, [], createConfig(rootDir))
    }

    const rawAgents = [
      {
        agentId: 'manager-1',
        role: 'manager',
        projectAgent: {
          handle: 'alpha',
          whenToUse: 'Use alpha',
          systemPrompt: 'Project-agent prompt is irrelevant to the counter.',
          capabilities: ['create_session'],
        },
      },
      {
        agentId: 'manager-2',
        role: 'manager',
      },
      {
        agentId: 'worker-1',
        role: 'worker',
        projectAgent: { handle: 'worker-alpha', whenToUse: 'Should not count' },
      },
      {
        agentId: 'manager-null-project-agent',
        role: 'manager',
        projectAgent: null,
      },
      'malformed-agent-record',
    ]
    const normalizedAgents = rawAgents.filter((agent) => typeof agent === 'object' && agent !== null)

    const rawFeatures = await collectForAgents(rawAgents)
    const normalizedFeatures = await collectForAgents(normalizedAgents)

    expect(rawFeatures.projectAgentsCount).toBe(1)
    expect(rawFeatures.projectAgentsPersistedCount).toBe(1)
    expect(rawFeatures.projectAgentsCount).toBe(normalizedFeatures.projectAgentsCount)
    expect(rawFeatures.projectAgentsPersistedCount).toBe(normalizedFeatures.projectAgentsPersistedCount)
  })

  it('counts terminals only under the profile root session terminal directory', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'feature-counters-terminals-root-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-terminals-data-'))
    const profileId = 'profile-1'

    await mkdir(join(getSessionTerminalsDir(dataDir, profileId, profileId), 'terminal-a'), { recursive: true })
    await mkdir(join(getSessionTerminalsDir(dataDir, profileId, profileId), 'terminal-b'), { recursive: true })
    await mkdir(join(getSessionTerminalsDir(dataDir, profileId, `${profileId}--s2`), 'terminal-child'), { recursive: true })

    const features = await collectFeatureAdoption(dataDir, [profileId], createConfig(rootDir))

    expect(features.terminalsActive).toBe(2)
  })

  it('adds specialist persisted/custom/enabled split without changing the legacy count', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'feature-counters-specialists-root-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-specialists-data-'))
    const profileId = 'profile-1'

    await writeSpecialist(join(dataDir, 'shared', 'specialists'), 'builtin.md', { builtin: true, enabled: true })
    await writeSpecialist(join(dataDir, 'shared', 'specialists'), 'custom-disabled.md', {
      builtin: false,
      enabled: false,
    })
    await writeSpecialist(join(dataDir, 'profiles', profileId, 'specialists'), 'profile-custom.md', {
      builtin: false,
      enabled: true,
    })

    const features = await collectFeatureAdoption(dataDir, [profileId], createConfig(rootDir))

    expect(features.specialistsConfigured).toBe(3)
    expect(features.specialistsPersistedCount).toBe(3)
    expect(features.specialistsCustomCount).toBe(2)
    expect(features.specialistsEnabledCount).toBe(2)
  })

  it('keeps legacy skill counts stable while exposing the clearer discovered total', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'feature-counters-skills-root-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-skills-data-'))
    const profileId = 'profile-1'

    await writeSkill(join(dataDir, 'skills'), 'local-skill')
    await writeSkill(join(dataDir, 'agent', 'skills'), 'worker-skill')
    await writeSkill(join(dataDir, 'agent', 'manager', 'skills'), 'manager-skill')
    await writeSkill(join(dataDir, 'profiles', profileId, 'pi', 'skills'), 'profile-skill')
    await writeSkill(join(rootDir, '.swarm', 'skills'), 'repo-skill')

    const features = await collectFeatureAdoption(dataDir, [profileId], createConfig(rootDir))

    expect(features.skillsConfigured).toBe(4)
    expect(features.skillsDiscoveredCount).toBe(5)
  })

  it('keeps legacy extension counts stable while exposing the clearer discovered total', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'feature-counters-extensions-root-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-extensions-data-'))
    const profileId = 'profile-1'

    await writeExtensionFile(join(dataDir, 'agent', 'extensions'), 'worker-extension.ts')
    await writeExtensionFile(join(dataDir, 'agent', 'manager', 'extensions'), 'manager-extension.js')
    await writeExtensionFile(join(dataDir, 'profiles', profileId, 'pi', 'extensions'), 'profile-extension.ts')
    await writeExtensionFile(join(rootDir, '.pi', 'extensions'), 'project-extension.ts')

    const features = await collectFeatureAdoption(dataDir, [profileId], createConfig(rootDir))

    expect(features.extensionsLoaded).toBe(3)
    expect(features.extensionsDiscoveredCount).toBe(4)
  })

  it('splits registered mobile devices from enabled devices', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'feature-counters-mobile-root-'))
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-mobile-data-'))
    await mkdir(join(dataDir, 'shared', 'state'), { recursive: true })
    await writeFile(
      join(dataDir, 'shared', 'state', 'mobile-devices.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-04-02T00:00:00.000Z',
        devices: [
          {
            token: 'device-1',
            platform: 'ios',
            deviceName: 'iPhone',
            registeredAt: '2026-04-02T00:00:00.000Z',
            enabled: true,
          },
          {
            token: 'device-2',
            platform: 'android',
            deviceName: 'Pixel',
            registeredAt: '2026-04-02T00:00:00.000Z',
            enabled: false,
          },
        ],
      }),
      'utf8',
    )

    const features = await collectFeatureAdoption(dataDir, [], createConfig(rootDir))

    expect(features.mobileDevicesRegistered).toBe(2)
    expect(features.mobileDevicesEnabledCount).toBe(1)
  })
})
