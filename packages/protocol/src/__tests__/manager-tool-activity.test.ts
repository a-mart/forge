import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ManagerToolActivityEvent } from '../manager-tool-activity.js'

const event = {
  type: 'manager_tool_activity',
  sessionAgentId: 'manager-1',
  revision: 3,
  toolCount: 2,
  currentToolName: 'read_file',
} satisfies ManagerToolActivityEvent

describe('ManagerToolActivityEvent', () => {
  it('is a bounded metadata-only wire shape', () => {
    expect(Object.keys(event)).toEqual([
      'type',
      'sessionAgentId',
      'revision',
      'toolCount',
      'currentToolName',
    ])
    expect(JSON.stringify(event)).not.toMatch(/args|result|text|toolCallId/)
    expectTypeOf<ManagerToolActivityEvent>().not.toMatchTypeOf<{
      args: unknown
      result: unknown
      text: string
      toolCallId: string
    }>()
  })
})
