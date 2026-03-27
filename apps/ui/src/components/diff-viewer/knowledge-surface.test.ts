import { describe, expect, it } from 'vitest'
import {
  classifyKnowledgeSurface,
  commitMatchesKnowledgeQuickFilter,
  groupFilesByKnowledgeSurface,
  matchesKnowledgeQuickFilter,
} from './knowledge-surface'

describe('knowledge-surface', () => {
  it('classifies tracked knowledge surfaces from versioned paths', () => {
    expect(classifyKnowledgeSurface('shared/knowledge/common.md').label).toBe('Common Knowledge')
    expect(classifyKnowledgeSurface('shared/knowledge/.cortex-notes.md').label).toBe('Cortex Notes')
    expect(classifyKnowledgeSurface('shared/knowledge/.cortex-worker-prompts.md').label).toBe('Cortex Worker Prompts')
    expect(classifyKnowledgeSurface('shared/knowledge/profiles/alpha.md').label).toBe('Profile Knowledge (legacy)')
    expect(classifyKnowledgeSurface('profiles/alpha/memory.md').label).toBe('Profile Memory')
    expect(classifyKnowledgeSurface('profiles/alpha/sessions/alpha--s1/memory.md').label).toBe('Profile Memory')
    expect(classifyKnowledgeSurface('profiles/alpha/reference/guide.md').label).toBe('Reference Docs')
    expect(classifyKnowledgeSurface('profiles/alpha/prompts/archetypes/review.md').label).toBe('Prompt Overrides')
    expect(classifyKnowledgeSurface('profiles/alpha/other.md').label).toBe('Other Tracked')
  })

  it('matches quick filters against tracked path prefixes', () => {
    expect(matchesKnowledgeQuickFilter('shared/knowledge/common.md', 'shared-knowledge')).toBe(true)
    expect(matchesKnowledgeQuickFilter('profiles/alpha/memory.md', 'profile-memory')).toBe(true)
    expect(matchesKnowledgeQuickFilter('profiles/alpha/sessions/alpha--s1/memory.md', 'profile-memory')).toBe(true)
    expect(matchesKnowledgeQuickFilter('profiles/alpha/reference/guide.md', 'reference-docs')).toBe(true)
    expect(matchesKnowledgeQuickFilter('profiles/alpha/prompts/operational/review.md', 'prompt-overrides')).toBe(true)
    expect(matchesKnowledgeQuickFilter('profiles/alpha/reference/guide.md', 'prompt-overrides')).toBe(false)
  })

  it('groups files in stable surface order', () => {
    const groups = groupFilesByKnowledgeSurface([
      { path: 'profiles/alpha/reference/guide.md' },
      { path: 'shared/knowledge/common.md' },
      { path: 'profiles/alpha/memory.md' },
    ])

    expect(groups.map((group) => group.surface.label)).toEqual([
      'Common Knowledge',
      'Profile Memory',
      'Reference Docs',
    ])
    expect(groups[0]?.files.map((file) => file.path)).toEqual(['shared/knowledge/common.md'])
  })

  it('filters commits using metadata paths', () => {
    expect(
      commitMatchesKnowledgeQuickFilter(
        {
          paths: ['profiles/alpha/reference/guide.md'],
          source: 'reference-doc',
        },
        'reference-docs',
      ),
    ).toBe(true)

    expect(
      commitMatchesKnowledgeQuickFilter(
        {
          paths: ['shared/knowledge/common.md'],
          source: 'agent-edit-tool',
        },
        'prompt-overrides',
      ),
    ).toBe(false)

    expect(commitMatchesKnowledgeQuickFilter(null, 'shared-knowledge')).toBe(false)
  })
})
