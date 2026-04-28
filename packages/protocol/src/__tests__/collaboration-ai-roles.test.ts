import { expect, expectTypeOf, it } from 'vitest'
import {
  COLLABORATION_AI_ROLE_IDS,
  type CollaborationAiRole,
  type CollaborationAiRoleId,
} from '../collaboration-ai-roles.js'
import { COLLABORATION_AI_ROLES } from '../collaboration-ai-roles-compat.js'

it('uses canonical string role ids while preserving builtin compatibility aliases', () => {
  const customRoleId: CollaborationAiRoleId = 'role-custom'

  expect(customRoleId).toBe('role-custom')
  expect(COLLABORATION_AI_ROLE_IDS).toEqual([
    'channel_assistant',
    'work_coordinator',
    'facilitator_scribe',
  ])
  expect(COLLABORATION_AI_ROLES).toBe(COLLABORATION_AI_ROLE_IDS)

  expectTypeOf<CollaborationAiRoleId>().toEqualTypeOf<string>()
  expectTypeOf<CollaborationAiRole>().toEqualTypeOf<
    'channel_assistant' | 'work_coordinator' | 'facilitator_scribe'
  >()
})
