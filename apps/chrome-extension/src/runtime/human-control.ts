export interface HumanInputObservation {
  isTrusted: boolean
  observedAt: number
  syntheticUntil: number
}

/** CDP-generated trusted DOM events are ignored only inside an active synthetic sequence window. */
export function isTrustedHumanInterruption(observation: HumanInputObservation): boolean {
  return observation.isTrusted && observation.observedAt > observation.syntheticUntil
}
