import type {
  GenerationThroughputEvent,
  GenerationThroughputLiveMeasurement,
  GenerationThroughputSnapshotEvent,
} from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'

export const MAX_GENERATION_THROUGHPUT_TOMBSTONES = 64

export interface GenerationThroughputReduction {
  patch: Partial<ManagerWsState>
  accepted: boolean
  terminal?: { agentId: string; measurementId: string; sequence: number }
}

/**
 * Cumulative generation updates are intentionally independent from transcript
 * reducers. They can arrive before a local start, after reconnect, or out of
 * order, so the measurement sequence is the only per-call authority.
 */
export function reduceGenerationThroughputEvent(
  state: ManagerWsState,
  event: GenerationThroughputEvent,
): GenerationThroughputReduction {
  const measurement = event.measurement
  if (!isCurrentSession(state, measurement.sessionId)) return { patch: {}, accepted: false }

  if (state.generationThroughputTombstonesByMeasurementId[measurement.measurementId] !== undefined) {
    return { patch: {}, accepted: false }
  }
  const knownSequence = state.generationThroughputSequenceByMeasurementId[measurement.measurementId]
  if (knownSequence !== undefined && measurement.sequence <= knownSequence) return { patch: {}, accepted: false }

  const current = state.generationThroughputByAgentId[measurement.agentId]
  if (current && current.measurementId !== measurement.measurementId && !replacesCurrentMeasurement(current, measurement)) {
    return { patch: {}, accepted: false }
  }

  const nextMeasurements = {
    ...state.generationThroughputByAgentId,
    [measurement.agentId]: measurement,
  }
  const nextSequences = {
    ...state.generationThroughputSequenceByMeasurementId,
    [measurement.measurementId]: measurement.sequence,
  }
  let tombstones = state.generationThroughputTombstonesByMeasurementId
  let tombstoneOrder = state.generationThroughputTombstoneOrder
  if (current && current.measurementId !== measurement.measurementId) {
    delete nextSequences[current.measurementId]
    const replacementTombstone = addGenerationThroughputTombstone(
      tombstones, tombstoneOrder, current.measurementId, current.sequence,
    )
    tombstones = replacementTombstone.generationThroughputTombstonesByMeasurementId
    tombstoneOrder = replacementTombstone.generationThroughputTombstoneOrder
  }
  if (measurement.phase === 'completed' || measurement.phase === 'aborted') {
    const terminalTombstone = addGenerationThroughputTombstone(
      tombstones, tombstoneOrder, measurement.measurementId, measurement.sequence,
    )
    tombstones = terminalTombstone.generationThroughputTombstonesByMeasurementId
    tombstoneOrder = terminalTombstone.generationThroughputTombstoneOrder
  }

  const nextLatestFinals = isExactFinal(measurement)
    ? { ...state.generationThroughputLatestFinalByAgentId, [measurement.agentId]: measurement }
    : state.generationThroughputLatestFinalByAgentId

  return {
    accepted: true,
    patch: {
      generationThroughputByAgentId: nextMeasurements,
      generationThroughputLatestFinalByAgentId: nextLatestFinals,
      generationThroughputSequenceByMeasurementId: nextSequences,
      ...(tombstones !== state.generationThroughputTombstonesByMeasurementId
        ? { generationThroughputTombstonesByMeasurementId: tombstones, generationThroughputTombstoneOrder: tombstoneOrder }
        : {}),
    },
    ...(measurement.phase === 'completed' || measurement.phase === 'aborted'
      ? {
          terminal: {
            agentId: measurement.agentId,
            measurementId: measurement.measurementId,
            sequence: measurement.sequence,
          },
        }
      : {}),
  }
}

export function reduceGenerationThroughputSnapshot(
  state: ManagerWsState,
  event: GenerationThroughputSnapshotEvent,
): GenerationThroughputReduction {
  if (!isCurrentSession(state, event.sessionAgentId)) return { patch: {}, accepted: false }

  const nextMeasurements: Record<string, GenerationThroughputLiveMeasurement> = {}
  const nextSequences: Record<string, number> = {}

  for (const measurement of event.measurements) {
    if (measurement.sessionId !== event.sessionAgentId) continue
    const current = nextMeasurements[measurement.agentId]
    if (current && !replacesCurrentMeasurement(current, measurement)) continue
    nextMeasurements[measurement.agentId] = measurement
    nextSequences[measurement.measurementId] = measurement.sequence
  }

  return {
    accepted: true,
    patch: {
      generationThroughputByAgentId: nextMeasurements,
      generationThroughputSequenceByMeasurementId: nextSequences,
      generationThroughputTombstonesByMeasurementId: {},
      generationThroughputTombstoneOrder: [],
    },
  }
}

export function clearGenerationThroughputForAgents(
  state: ManagerWsState,
  agentIds: Iterable<string>,
): Partial<ManagerWsState> {
  const ids = new Set(agentIds)
  if (ids.size === 0) return {}
  let changed = false
  const measurements = { ...state.generationThroughputByAgentId }
  const latestFinals = { ...state.generationThroughputLatestFinalByAgentId }
  const sequences = { ...state.generationThroughputSequenceByMeasurementId }

  for (const agentId of ids) {
    const measurement = measurements[agentId]
    if (measurement) {
      changed = true
      delete measurements[agentId]
      delete sequences[measurement.measurementId]
    }
    if (latestFinals[agentId]) {
      changed = true
      delete latestFinals[agentId]
    }
  }

  return changed
    ? {
        generationThroughputByAgentId: measurements,
        generationThroughputLatestFinalByAgentId: latestFinals,
        generationThroughputSequenceByMeasurementId: sequences,
      }
    : {}
}

/** Clear transient calls while retaining the latest exact result through reconnects. */
export function clearGenerationThroughputState(): Pick<
  ManagerWsState,
  | 'generationThroughputByAgentId'
  | 'generationThroughputSequenceByMeasurementId'
  | 'generationThroughputTombstonesByMeasurementId'
  | 'generationThroughputTombstoneOrder'
> {
  return {
    generationThroughputByAgentId: {},
    generationThroughputSequenceByMeasurementId: {},
    generationThroughputTombstonesByMeasurementId: {},
    generationThroughputTombstoneOrder: [],
  }
}

export function removeGenerationThroughputTombstone(
  state: ManagerWsState,
  input: { agentId: string; measurementId: string; sequence: number },
): Partial<ManagerWsState> {
  const current = state.generationThroughputByAgentId[input.agentId]
  if (
    !current
    || current.measurementId !== input.measurementId
    || current.sequence !== input.sequence
    || (current.phase !== 'completed' && current.phase !== 'aborted')
  ) {
    return {}
  }

  return {
    generationThroughputByAgentId: Object.fromEntries(
      Object.entries(state.generationThroughputByAgentId)
        .filter(([agentId]) => agentId !== input.agentId),
    ),
    generationThroughputSequenceByMeasurementId: Object.fromEntries(
      Object.entries(state.generationThroughputSequenceByMeasurementId)
        .filter(([measurementId]) => measurementId !== input.measurementId),
    ),
  }
}

function addGenerationThroughputTombstone(
  existing: ManagerWsState['generationThroughputTombstonesByMeasurementId'],
  existingOrder: ManagerWsState['generationThroughputTombstoneOrder'],
  measurementId: string,
  sequence: number,
): Pick<ManagerWsState, 'generationThroughputTombstonesByMeasurementId' | 'generationThroughputTombstoneOrder'> {
  const tombstones = { ...existing, [measurementId]: Math.max(existing[measurementId] ?? 0, sequence) }
  const tombstoneOrder = [...existingOrder.filter((id) => id !== measurementId), measurementId]
  while (tombstoneOrder.length > MAX_GENERATION_THROUGHPUT_TOMBSTONES) {
    const expired = tombstoneOrder.shift()
    if (expired) delete tombstones[expired]
  }
  return {
    generationThroughputTombstonesByMeasurementId: tombstones,
    generationThroughputTombstoneOrder: tombstoneOrder,
  }
}

function isExactFinal(measurement: GenerationThroughputLiveMeasurement): boolean {
  const rate = measurement.generationAverageTokensPerSecond
  return measurement.phase === 'completed'
    && measurement.valueKind === 'provider_final'
    && measurement.outputTokens !== null
    && typeof rate === 'number'
    && Number.isFinite(rate)
    && rate >= 0
}

function replacesCurrentMeasurement(
  current: GenerationThroughputLiveMeasurement,
  incoming: GenerationThroughputLiveMeasurement,
): boolean {
  if (current.measurementId === incoming.measurementId) {
    return incoming.sequence > current.sequence
  }
  return Date.parse(incoming.sampledAt) >= Date.parse(current.sampledAt)
}

function isCurrentSession(state: ManagerWsState, sessionAgentId: string): boolean {
  const targetAgentId = state.targetAgentId ?? state.subscribedAgentId
  if (!targetAgentId) return false
  if (targetAgentId === sessionAgentId) return true
  const target = state.agents.find((agent) => agent.agentId === targetAgentId)
  return target?.role === 'worker' && target.managerId === sessionAgentId
}
