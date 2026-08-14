import { describe, expect, it } from 'vitest'
import { layoutCommitGraph } from './commit-graph-layout'

describe('layoutCommitGraph', () => {
  it('keeps a linear history in a single column', () => {
    const rows = layoutCommitGraph([
      { sha: 'c3', parents: ['c2'] },
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: [] },
    ])

    expect(rows.map((row) => row.column)).toEqual([0, 0, 0])
    expect(rows.every((row) => row.laneCount === 1)).toBe(true)
    expect(rows[0]?.edges).toEqual([{ from: 0, to: 0, kind: 'parent' }])
  })

  it('opens a second lane for a side branch and closes it after the merge', () => {
    const rows = layoutCommitGraph([
      { sha: 'merge', parents: ['main', 'feature'] },
      { sha: 'feature', parents: ['base'] },
      { sha: 'main', parents: ['base'] },
      { sha: 'base', parents: [] },
    ])

    expect(rows[0]).toMatchObject({
      sha: 'merge',
      column: 0,
      edges: [
        { from: 0, to: 0, kind: 'parent' },
        { from: 0, to: 1, kind: 'merge' },
      ],
    })
    expect(rows[1]).toMatchObject({
      sha: 'feature',
      column: 1,
    })
    expect(rows[2]).toMatchObject({
      sha: 'main',
      column: 0,
    })
    expect(rows[3]).toMatchObject({
      sha: 'base',
      column: 0,
      laneCount: 2,
      joins: [1],
    })
  })

  it('places unpublished commits above origin/main on the same first-parent lane', () => {
    const rows = layoutCommitGraph([
      { sha: 'local-2', parents: ['local-1'] },
      { sha: 'local-1', parents: ['origin'] },
      { sha: 'origin', parents: ['older'] },
      { sha: 'older', parents: [] },
    ])

    expect(rows.map((row) => ({ sha: row.sha, column: row.column, laneCount: row.laneCount }))).toEqual([
      { sha: 'local-2', column: 0, laneCount: 1 },
      { sha: 'local-1', column: 0, laneCount: 1 },
      { sha: 'origin', column: 0, laneCount: 1 },
      { sha: 'older', column: 0, laneCount: 1 },
    ])
  })
})
