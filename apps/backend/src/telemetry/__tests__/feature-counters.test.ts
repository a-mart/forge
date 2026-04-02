import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectFeatureAdoption } from '../feature-counters.js'
import type { SwarmConfig } from '../../swarm/types.js'

async function writeSkill(baseDir: string, skillName: string) {
  const skillDir = join(baseDir, skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf8')
}

describe('feature counters', () => {
  it('counts persisted project agents from the agents registry', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-project-agents-'))
    await mkdir(join(dataDir, 'swarm'), { recursive: true })
    await writeFile(
      join(dataDir, 'swarm', 'agents.json'),
      JSON.stringify({
        agents: [
          {
            agentId: 'manager-1',
            role: 'manager',
            projectAgent: { handle: 'alpha', whenToUse: 'Use alpha' },
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
        ],
      }),
      'utf8',
    )

    const features = await collectFeatureAdoption(dataDir, [], {} as SwarmConfig)

    expect(features.projectAgentsCount).toBe(1)
  })

  it('counts local, worker, manager, and profile skill directories', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'feature-counters-skills-'))
    const profileId = 'profile-1'

    await writeSkill(join(dataDir, 'skills'), 'local-skill')
    await writeSkill(join(dataDir, 'agent', 'skills'), 'worker-skill')
    await writeSkill(join(dataDir, 'agent', 'manager', 'skills'), 'manager-skill')
    await writeSkill(join(dataDir, 'profiles', profileId, 'pi', 'skills'), 'profile-skill')

    const features = await collectFeatureAdoption(dataDir, [profileId], {} as SwarmConfig)

    expect(features.skillsConfigured).toBe(4)
  })
})
