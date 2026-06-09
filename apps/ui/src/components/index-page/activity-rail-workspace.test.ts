/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { isActivityRailWorkspaceAvailable } from './activity-rail-workspace'

describe('isActivityRailWorkspaceAvailable', () => {
  it('returns false when only fallback manager id would be available', () => {
    expect(isActivityRailWorkspaceAvailable(null, null)).toBe(false)
    expect(isActivityRailWorkspaceAvailable('agent-1', null)).toBe(false)
    expect(isActivityRailWorkspaceAvailable(null, { agentId: '__default__' })).toBe(false)
  })

  it('returns true when both a session and manager agent exist', () => {
    expect(
      isActivityRailWorkspaceAvailable('session-1', { agentId: 'manager-1' }),
    ).toBe(true)
  })
})
