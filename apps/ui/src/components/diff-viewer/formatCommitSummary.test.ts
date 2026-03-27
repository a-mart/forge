import { describe, expect, it } from 'vitest'
import { formatCommitSummary } from './formatCommitSummary'

describe('formatCommitSummary', () => {
  it('formats common knowledge edits from structured metadata', () => {
    expect(
      formatCommitSummary({
        message: 'agent(cortex): update tracked file',
        metadata: {
          source: 'agent-edit-tool',
          profileId: 'cortex',
          sessionId: 'cortex--s4',
          paths: ['shared/knowledge/common.md'],
        },
      }),
    ).toBe('Updated common knowledge for cortex (session cortex--s4)')
  })

  it('formats reference and prompt commit summaries without parsing the subject line', () => {
    expect(
      formatCommitSummary({
        message: 'knowledge(alpha): update 2 tracked files',
        metadata: {
          source: 'reference-doc',
          profileId: 'alpha',
          paths: ['profiles/alpha/reference/guide.md'],
        },
      }),
    ).toBe('Synced reference docs for alpha')

    expect(
      formatCommitSummary({
        message: 'prompt(alpha): save archetype/review',
        metadata: {
          source: 'prompt-save',
          profileId: 'alpha',
          paths: ['profiles/alpha/prompts/archetypes/review.md'],
        },
      }),
    ).toBe('Prompt override edited for alpha')
  })

  it('formats reconcile commits and falls back to the raw subject when metadata is missing', () => {
    expect(
      formatCommitSummary({
        message: 'versioning: reconcile tracked files',
        metadata: {
          source: 'reconcile',
          paths: ['shared/knowledge/common.md', 'profiles/alpha/memory.md'],
        },
      }),
    ).toBe('Reconcile: tracked knowledge changes')

    expect(
      formatCommitSummary({
        message: 'workspace: manual tidy\n\nextra detail',
        metadata: null,
      }),
    ).toBe('workspace: manual tidy')
  })
})
