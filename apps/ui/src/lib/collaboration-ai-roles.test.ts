import { describe, expect, it } from 'vitest'
import {
  AI_ROLE_OPTIONS,
  aiRoleLabel,
  COLLABORATION_AI_ROLE_IDS,
  DEFAULT_AI_ROLE,
} from './collaboration-ai-roles'

describe('collaboration-ai-roles', () => {
  it('exports all three canonical roles', () => {
    expect(COLLABORATION_AI_ROLE_IDS).toEqual([
      'channel_assistant',
      'work_coordinator',
      'facilitator_scribe',
    ])
  })

  it('provides a display option for every role', () => {
    const optionValues = AI_ROLE_OPTIONS.map((option) => option.value)
    for (const role of COLLABORATION_AI_ROLE_IDS) {
      expect(optionValues).toContain(role)
    }
  })

  it('every option has a non-empty label and description', () => {
    for (const option of AI_ROLE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.description.length).toBeGreaterThan(0)
    }
  })

  it('aiRoleLabel returns human-readable labels', () => {
    expect(aiRoleLabel('channel_assistant')).toBe('Channel Assistant')
    expect(aiRoleLabel('work_coordinator')).toBe('Work Coordinator')
    expect(aiRoleLabel('facilitator_scribe')).toBe('Facilitator & Scribe')
  })

  it('DEFAULT_AI_ROLE is channel_assistant', () => {
    expect(DEFAULT_AI_ROLE).toBe('channel_assistant')
  })
})
