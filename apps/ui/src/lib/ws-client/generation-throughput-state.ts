import type {
  GenerationThroughputEvent,
  GenerationThroughputLiveMeasurement,
  GenerationThroughputSnapshotEvent,
} from '@forge/protocol'
import type { GenerationRateSample, ManagerWsState } from '../ws-state'

export const MAX_GENERATION_RATE_SAMPLES = 20

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

  const knownSequence = state.generationThroughputSequenceByMeasurementId[measurement.measurementId]
  if (knownSequence !== undefined && measurement.sequence <= knownSequence) {
    return { patch: {}, accepted: false }
  }

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
  const nextSamples = current?.measurementId === measurement.measurementId
    ? state.generationRateSamplesByAgentId
    : removeAgentSamples(state.generationRateSamplesByAgentId, measurement.agentId)
  const samples = appendRateSample(
    nextSamples[measurement.agentId] ?? [],
    measurement,
  )
  const rateSamplesByAgentId = samples === nextSamples[measurement.agentId]
    ? nextSamples
    : { ...nextSamples, [measurement.agentId]: samples }

  const sessionSummary = event.sessionSummary && event.sessionSummary.sessionAgentId === measurement.sessionId
    ? event.sessionSummary
    : state.generationThroughputSessionSummary

  return {
    accepted: true,
    patch: {
      generationThroughputByAgentId: nextMeasurements,
      generationRateSamplesByAgentId: rateSamplesByAgentId,
      generationThroughputSequenceByMeasurementId: nextSequences,
      ...(sessionSummary !== state.generationThroughputSessionSummary
        ? { generationThroughputSessionSummary: sessionSummary }
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
  const nextSamples: Record<string, GenerationRateSample[]> = {}

  for (const measurement of event.measurements) {
    if (measurement.sessionId !== event.sessionAgentId) continue
    const current = nextMeasurements[measurement.agentId]
    if (current && !replacesCurrentMeasurement(current, measurement)) continue
    nextMeasurements[measurement.agentId] = measurement
    nextSequences[measurement.measurementId] = measurement.sequence
    const samples = appendRateSample([], measurement)
    if (samples.length > 0) nextSamples[measurement.agentId] = samples
  }

  return {
    accepted: true,
    patch: {
      generationThroughputByAgentId: nextMeasurements,
      generationRateSamplesByAgentId: nextSamples,
      generationThroughputSequenceByMeasurementId: nextSequences,
      generationThroughputSessionSummary: event.sessionSummary,
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
  const samples = { ...state.generationRateSamplesByAgentId }
  const sequences = { ...state.generationThroughputSequenceByMeasurementId }

  for (const agentId of ids) {
    const measurement = measurements[agentId]
    if (!measurement) continue
    changed = true
    delete measurements[agentId]
    delete samples[agentId]
    delete sequences[measurement.measurementId]
  }

  return changed
    ? {
        generationThroughputByAgentId: measurements,
        generationRateSamplesByAgentId: samples,
        generationThroughputSequenceByMeasurementId: sequences,
      }
    : {}
}

export function clearGenerationThroughputState(): Pick<
  ManagerWsState,
  | 'generationThroughputByAgentId'
  | 'generationRateSamplesByAgentId'
  | 'generationThroughputSequenceByMeasurementId'
  | 'generationThroughputSessionSummary'
> {
  return {
    generationThroughputByAgentId: {},
    generationRateSamplesByAgentId: {},
    generationThroughputSequenceByMeasurementId: {},
    generationThroughputSessionSummary: null,
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

  return clearGenerationThroughputForAgents(state, [input.agentId])
}

function appendRateSample(
  existing: GenerationRateSample[],
  measurement: GenerationThroughputLiveMeasurement,
): GenerationRateSample[] {
  const tokensPerSecond = measurement.instantaneousTokensPerSecond
  if (
    measurement.phase !== 'generating'
    || measurement.valueKind !== 'estimated'
    || typeof tokensPerSecond !== 'number'
    || !Number.isFinite(tokensPerSecond)
    || tokensPerSecond < 0
  ) {
    return existing
  }

  const last = existing.at(-1)
  if (last?.sampledAt === measurement.sampledAt && last.tokensPerSecond === tokensPerSecond) {
    return existing
  }
  return [
    ...existing,
    { sampledAt: measurement.sampledAt, tokensPerSecond },
  ].slice(-MAX_GENERATION_RATE_SAMPLES)
}

function removeAgentSamples(
  samplesByAgentId: ManagerWsState['generationRateSamplesByAgentId'],
  agentId: string,
): ManagerWsState['generationRateSamplesByAgentId'] {
  if (!samplesByAgentId[agentId]) return samplesByAgentId
  const next = { ...samplesByAgentId }
  delete next[agentId]
  return next
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
