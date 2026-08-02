import { describe, expect, it } from 'vitest'
import { createInitialManagerWsState } from '../ws-state'
import { reduceManagerToolActivity } from './manager-tool-activity-state'

describe('reduceManagerToolActivity', () => {
  it('accepts empty bootstrap authority for the selected manager and rejects stale revisions', () => {
    const initial = createInitialManagerWsState('manager-1')
    const empty = {
      type: 'manager_tool_activity' as const,
      sessionAgentId: 'manager-1',
      revision: 4,
      toolCount: 0,
    }
    const live = {
      type: 'manager_tool_activity' as const,
      sessionAgentId: 'manager-1',
      revision: 5,
      toolCount: 2,
      currentToolName: 'read_file',
    }

    const withEmpty = { ...initial, ...reduceManagerToolActivity(initial, empty)! }
    const withLive = { ...withEmpty, ...reduceManagerToolActivity(withEmpty, live)! }

    expect(withEmpty.managerToolActivity).toEqual(empty)
    expect(withLive.managerToolActivity).toEqual(live)
    expect(reduceManagerToolActivity(withLive, { ...empty, revision: 3 })).toBeNull()
  })

  it('rejects a different session so session switches cannot accept stale activity', () => {
    const state = createInitialManagerWsState('manager-2')
    expect(reduceManagerToolActivity(state, {
      type: 'manager_tool_activity',
      sessionAgentId: 'manager-1',
      revision: 9,
      toolCount: 4,
      currentToolName: 'bash',
    })).toBeNull()
  })
})
