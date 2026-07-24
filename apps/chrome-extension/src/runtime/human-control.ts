export interface HumanInputObservation {
  isTrusted: boolean
  observedAt: number
  syntheticUntil: number
}

/** CDP-generated trusted DOM events are ignored only inside an active synthetic sequence window. */
export function isTrustedHumanInterruption(observation: HumanInputObservation): boolean {
  return observation.isTrusted && observation.observedAt > observation.syntheticUntil
}

export interface SyntheticInputOperation {
  leaseId: string
  leaseEpoch: number
  tabId: number
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText' | 'Input.dispatchTouchEvent'
  params: Record<string, unknown>
}

export interface SyntheticInputHooks {
  beginAgentControl(operation: SyntheticInputOperation): Promise<number>
  signalStart(operation: SyntheticInputOperation, operationId: string, controlEpoch: number): Promise<{ operationId: string; controlEpoch: number }>
  isCurrent(operation: SyntheticInputOperation, controlEpoch: number): boolean
  sendCdpInput(operation: SyntheticInputOperation): Promise<unknown>
  signalEnd(operation: SyntheticInputOperation, operationId: string, controlEpoch: number): Promise<void> | void
  randomId(): string
}

/**
 * The input primitive does not claim a protocol operation implementation. It brackets the existing
 * CDP Input seam with content-script acknowledgement and lease/control-epoch checks so stale or
 * unmatched trusted input cannot be mistaken for the agent's own sequence.
 */
export class SyntheticInputSequencer {
  constructor(private readonly hooks: SyntheticInputHooks) {}

  async run(operation: SyntheticInputOperation): Promise<unknown> {
    const controlEpoch = await this.hooks.beginAgentControl(operation)
    const operationId = this.hooks.randomId()
    try {
      const acknowledgement = await this.hooks.signalStart(operation, operationId, controlEpoch)
      if (acknowledgement.operationId !== operationId || acknowledgement.controlEpoch !== controlEpoch ||
          !this.hooks.isCurrent(operation, controlEpoch)) {
        throw new Error('synthetic input acknowledgement is stale')
      }
      const result = await this.hooks.sendCdpInput(operation)
      if (!this.hooks.isCurrent(operation, controlEpoch)) throw new Error('synthetic input was interrupted by trusted human control')
      return result
    } finally {
      await this.hooks.signalEnd(operation, operationId, controlEpoch)
    }
  }
}
