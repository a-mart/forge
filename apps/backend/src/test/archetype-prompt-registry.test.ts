import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadArchetypePromptRegistry } from '../swarm/archetypes/archetype-prompt-registry.js'

describe('loadArchetypePromptRegistry', () => {
  it('loads built-in manager, merger, and cortex prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-archetype-prompt-test-'))
    const repoOverridesDir = join(root, '.swarm', 'archetypes')

    const registry = await loadArchetypePromptRegistry({ repoOverridesDir })

    expect(registry.resolvePrompt('manager')).toContain('You are the manager agent in a multi-agent swarm.')
    expect(registry.resolvePrompt('merger')).toContain('You are the merger agent in a multi-agent swarm.')
    expect(registry.resolvePrompt('cortex')).toContain('You are Cortex')
  })

  it('applies repo markdown overrides with precedence by archetype id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-archetype-prompt-test-'))
    const repoOverridesDir = join(root, '.swarm', 'archetypes')
    await mkdir(repoOverridesDir, { recursive: true })

    await writeFile(join(repoOverridesDir, 'manager.md'), 'repo manager override\n', 'utf8')

    const registry = await loadArchetypePromptRegistry({ repoOverridesDir })

    expect(registry.resolvePrompt('manager')).toBe('repo manager override')
    expect(registry.resolvePrompt('merger')).toContain('You are the merger agent in a multi-agent swarm.')
  })
})
