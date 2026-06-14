/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest'
import { isActivityRailWorkspaceAvailable, resolveChatRailTargetAgentId } from './activity-rail-workspace'

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

describe('resolveChatRailTargetAgentId', () => {
  it('keeps Chat on the active manager when a manager is selected', () => {
    expect(
      resolveChatRailTargetAgentId(
        'manager-1',
        { agentId: 'manager-1', role: 'manager', managerId: 'manager-1' },
        { agentId: 'manager-1' },
      ),
    ).toBe('manager-1')
  })

  it('returns the parent manager when a worker is selected', () => {
    expect(
      resolveChatRailTargetAgentId(
        'worker-1',
        { agentId: 'worker-1', role: 'worker', managerId: 'manager-1' },
        { agentId: 'manager-1' },
      ),
    ).toBe('manager-1')
  })

  it('falls back to the worker managerId if the manager descriptor is not loaded yet', () => {
    expect(
      resolveChatRailTargetAgentId(
        'worker-1',
        { agentId: 'worker-1', role: 'worker', managerId: 'manager-1' },
        null,
      ),
    ).toBe('manager-1')
  })
})
