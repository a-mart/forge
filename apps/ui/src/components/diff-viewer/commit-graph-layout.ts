export interface CommitGraphInput {
  sha: string
  parents?: string[]
}

export interface CommitGraphEdge {
  from: number
  to: number
  kind: 'parent' | 'merge'
}

export interface CommitGraphRow {
  sha: string
  column: number
  laneCount: number
  incoming: number[]
  continuing: number[]
  joins: number[]
  edges: CommitGraphEdge[]
}

const COMMIT_GRAPH_LANE_WIDTH = 12
const COMMIT_GRAPH_PADDING_X = 8

export function commitGraphWidth(laneCount: number): number {
  return Math.max(laneCount * COMMIT_GRAPH_LANE_WIDTH + COMMIT_GRAPH_PADDING_X * 2, 20)
}

export function commitGraphLaneX(column: number): number {
  return COMMIT_GRAPH_PADDING_X + column * COMMIT_GRAPH_LANE_WIDTH
}

const EMPTY_PARENTS: string[] = []

export function layoutCommitGraph(commits: CommitGraphInput[]): CommitGraphRow[] {
  const rows: CommitGraphRow[] = []
  const lanes: Array<string | null> = []

  for (const commit of commits) {
    const parents = commit.parents?.filter((parent) => parent.length > 0) ?? EMPTY_PARENTS
    const matchingLanes = findLaneIndexes(lanes, commit.sha)
    const column = matchingLanes[0] ?? firstOpenLane(lanes)
    const incoming = occupiedLaneIndexes(lanes)

    ensureLane(lanes, column)
    lanes[column] = commit.sha

    const nextLanes = [...lanes]
    const reserved = new Set<number>()
    const edges: CommitGraphEdge[] = []

    for (const [parentIndex, parent] of parents.entries()) {
      const existing = findLaneIndexes(nextLanes, parent).find((lane) => !reserved.has(lane))
      const target =
        parentIndex === 0 && !reserved.has(column)
          ? column
          : existing ?? firstOpenLane(nextLanes, reserved)

      ensureLane(nextLanes, target)
      nextLanes[target] = parent
      reserved.add(target)
      edges.push({
        from: column,
        to: target,
        kind: parentIndex === 0 ? 'parent' : 'merge',
      })
    }

    for (const lane of matchingLanes) {
      if (!reserved.has(lane)) {
        nextLanes[lane] = null
      }
    }

    if (parents.length === 0 && !reserved.has(column)) {
      nextLanes[column] = null
    }

    compactTrailingEmptyLanes(nextLanes)
    const continuing = occupiedLaneIndexes(nextLanes)
    const joins = matchingLanes.filter((lane) => lane !== column)
    const laneCount = Math.max(lanes.length, nextLanes.length, column + 1, 1)

    rows.push({
      sha: commit.sha,
      column,
      laneCount,
      incoming,
      continuing,
      joins,
      edges,
    })

    lanes.length = nextLanes.length
    for (let index = 0; index < nextLanes.length; index += 1) {
      lanes[index] = nextLanes[index] ?? null
    }
    compactTrailingEmptyLanes(lanes)
  }

  return rows
}

function findLaneIndexes(lanes: Array<string | null>, sha: string): number[] {
  const matches: number[] = []
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] === sha) {
      matches.push(index)
    }
  }
  return matches
}

function firstOpenLane(lanes: Array<string | null>, reserved: Set<number> = new Set()): number {
  for (let index = 0; index < lanes.length; index += 1) {
    if (!reserved.has(index) && lanes[index] == null) {
      return index
    }
  }
  return lanes.length
}

function ensureLane(lanes: Array<string | null>, index: number): void {
  while (lanes.length <= index) {
    lanes.push(null)
  }
}

function compactTrailingEmptyLanes(lanes: Array<string | null>): void {
  while (lanes.length > 0 && lanes[lanes.length - 1] == null) {
    lanes.pop()
  }
}

function occupiedLaneIndexes(lanes: Array<string | null>): number[] {
  const indexes: number[] = []
  for (let index = 0; index < lanes.length; index += 1) {
    if (lanes[index] != null) {
      indexes.push(index)
    }
  }
  return indexes
}
