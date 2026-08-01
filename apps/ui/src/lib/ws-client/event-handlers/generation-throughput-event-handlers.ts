import type { ServerEvent } from '@forge/protocol'
import type { ManagerWsState } from '../../ws-state'
import {
  reduceGenerationThroughputEvent,
  reduceGenerationThroughputSnapshot,
  type GenerationThroughputReduction,
} from '../generation-throughput-state'

export interface ManagerWsGenerationThroughputEventContext {
  state: ManagerWsState
  applyGenerationThroughputReduction: (reduction: GenerationThroughputReduction) => void
}

/** Handles only Builder-local count telemetry; it never enters conversation handlers. */
export function handleGenerationThroughputEvent(
  event: ServerEvent,
  context: ManagerWsGenerationThroughputEventContext,
): boolean {
  if (event.type === 'generation_throughput') {
    context.applyGenerationThroughputReduction(reduceGenerationThroughputEvent(context.state, event))
    return true
  }

  if (event.type === 'generation_throughput_snapshot') {
    context.applyGenerationThroughputReduction(reduceGenerationThroughputSnapshot(context.state, event))
    return true
  }

  return false
}
