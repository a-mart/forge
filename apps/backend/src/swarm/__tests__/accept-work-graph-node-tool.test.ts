import { describe, expect, it } from 'vitest'
import {
  normalizeAcceptWorkGraphNodeInput,
} from '../planning/accept-work-graph-node-tool.js'

describe('accept_work_graph_node guidance', () => {
  it('normalizes evidence and rejects invalid targeted input', () => {
    expect(normalizeAcceptWorkGraphNodeInput({
      nodeId: 'research',
      evidence: '  Verified the cited source path.  ',
    })).toEqual({
      nodeId: 'research',
      evidence: 'Verified the cited source path.',
    })
    expect(() => normalizeAcceptWorkGraphNodeInput({
      nodeId: 'Research',
      evidence: 'Verified.',
    })).toThrow('valid stable work-graph node id')
    expect(() => normalizeAcceptWorkGraphNodeInput({
      nodeId: 'research',
      evidence: '   ',
    })).toThrow('evidence must contain')
  })
})
