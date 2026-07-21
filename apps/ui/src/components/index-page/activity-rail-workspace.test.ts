/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isActivityRailViewportAvailable,
  isActivityRailWorkspaceAvailable,
  resolveChatRailTargetAgentId,
  resolveSourceControlDeepLinkPresentation,
} from './activity-rail-workspace'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('isActivityRailViewportAvailable', () => {
  it('uses inline Source Control only at the activity-rail breakpoint', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    expect(isActivityRailViewportAvailable()).toBe(true)
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 768px)')

    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    expect(isActivityRailViewportAvailable()).toBe(false)
  })
})

describe('resolveSourceControlDeepLinkPresentation', () => {
  it('routes an available desktop workspace to inline Source Control', () => {
    expect(resolveSourceControlDeepLinkPresentation(
      'session-1',
      { agentId: 'manager-1' },
      true,
    )).toBe('inline')
  })

  it.each([
    ['mobile viewport', 'session-1', { agentId: 'manager-1' }, false],
    ['missing active session', null, { agentId: 'manager-1' }, true],
    ['missing manager workspace', 'session-1', null, true],
  ] as const)('uses the modal fallback for a %s', (_label, activeAgentId, manager, viewport) => {
    expect(resolveSourceControlDeepLinkPresentation(activeAgentId, manager, viewport)).toBe('modal')
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
