import type { WorkGraphNode } from '@forge/protocol'

/**
 * Finds the worker for the node's current attempt. Attempts are append-only, so
 * the final entry is the same attempt the graph coordinator treats as current.
 */
export function getWorkGraphNodeWorkerId(node: WorkGraphNode): string | undefined {
  return node.attempts.at(-1)?.workerId
}
