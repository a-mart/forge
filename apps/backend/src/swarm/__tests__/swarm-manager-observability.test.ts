import { describe, expect, it } from 'vitest'
import type { PhoenixObservabilitySettings, PhoenixObservabilitySettingsPatch, PhoenixObservabilityStatus, PhoenixObservabilityTestResponse } from '@forge/protocol'
import type {
  ObservabilityFacade,
  ObservabilityPromptResolvedInput,
  ObservabilityRuntimeCreatedInput,
  ObservabilityRuntimeInputCompletion,
  ObservabilityRuntimeInputHandle,
  ObservabilityRuntimeInputInput,
  ObservabilityRuntimeSessionEventInput,
} from '../../observability/observability-types.js'
import { createDefaultPhoenixObservabilitySettings } from '../../observability/observability-settings.js'
import { createTempConfig } from '../../test-support/temp-config.js'
import { TestSwarmManager, bootWithDefaultManager } from '../../test-support/swarm-manager-harness.js'

class RecordingObservability implements ObservabilityFacade {
  readonly calls: string[] = []
  readonly runtimeInputs: ObservabilityRuntimeInputInput[] = []
  readonly completions: ObservabilityRuntimeInputCompletion[] = []
  readonly sessionEvents: ObservabilityRuntimeSessionEventInput[] = []
  private nextRoot = 0

  async initialize(): Promise<void> {}
  async getSettings(): Promise<PhoenixObservabilitySettings> { return createDefaultPhoenixObservabilitySettings() }
  async updateSettings(_patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings> { return createDefaultPhoenixObservabilitySettings() }
  getStatus(): PhoenixObservabilityStatus {
    return {
      enabled: true,
      runtimeTarget: 'builder',
      contentMode: 'rich',
      exporter: {
        configured: true,
        active: true,
        endpoint: 'http://127.0.0.1:6006/v1/traces',
        projectName: 'default',
        lastSuccessfulExportAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
      counters: {
        spansStarted: 0,
        spansEnded: 0,
        accepted: 0,
        droppedQueueFull: 0,
        exportSucceeded: 0,
        exportFailed: 0,
        contentTruncations: 0,
        redactionMatches: 0,
        correlationMisses: 0,
        correlationEvictions: 0,
      },
    }
  }
  async testConnection(_patch?: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilityTestResponse> { return { ok: true, status: this.getStatus() } }
  recordPromptResolved(_input: ObservabilityPromptResolvedInput): void {}
  recordRuntimeCreated(_input: ObservabilityRuntimeCreatedInput): void {}
  beginRuntimeInput(input: ObservabilityRuntimeInputInput): ObservabilityRuntimeInputHandle {
    this.calls.push('beginRuntimeInput')
    this.runtimeInputs.push(input)
    this.nextRoot += 1
    return { rootTurnId: `root-${this.nextRoot}`, targetAgentId: input.targetAgentId, runtimeToken: input.runtimeToken }
  }
  completeRuntimeInput(_handle: ObservabilityRuntimeInputHandle | undefined, patch: ObservabilityRuntimeInputCompletion): void {
    this.calls.push('completeRuntimeInput')
    this.completions.push(patch)
  }
  cancelRuntimeInput(_handle: ObservabilityRuntimeInputHandle | undefined, _reason: string): void {
    this.calls.push('cancelRuntimeInput')
  }
  recordRuntimeInput(input: ObservabilityRuntimeInputInput): string | undefined {
    return this.beginRuntimeInput(input).rootTurnId
  }
  recordRuntimeSessionEvent(input: ObservabilityRuntimeSessionEventInput): void {
    this.calls.push(`event:${input.event.type}`)
    this.sessionEvents.push(input)
  }
  recordFeedback(): void {}
  async shutdown(): Promise<void> {}
}

describe('SwarmManager Phoenix observability dispatch correlation', () => {
  it('registers runtime input before a runtime synchronously emits turn_start during sendMessage', async () => {
    const handle = await createTempConfig({ prefix: 'forge-observability-dispatch-' })
    try {
      const observability = new RecordingObservability()
      const manager = new TestSwarmManager(handle.config, { observability })
      const descriptor = await bootWithDefaultManager(manager, handle.config)
      observability.calls.length = 0
      observability.runtimeInputs.length = 0
      observability.completions.length = 0
      observability.sessionEvents.length = 0
      const runtime = manager.runtimeByAgentId.get(descriptor.agentId)
      if (!runtime) throw new Error('expected test runtime')
      runtime.onSendMessage = async () => {
        await manager.handleRuntimeSessionEvent(descriptor.agentId, { type: 'turn_start' })
      }

      await manager.dispatchRuntimeUserMessage({
        targetAgentId: descriptor.agentId,
        text: 'hello before resolve',
        sourceContext: { channel: 'web' },
      })

      expect(observability.calls.indexOf('beginRuntimeInput')).toBeLessThan(observability.calls.indexOf('event:turn_start'))
      expect(observability.calls).toContain('completeRuntimeInput')
      expect(observability.runtimeInputs[0]).toMatchObject({ targetAgentId: descriptor.agentId, rootSource: 'user_input' })
      expect(observability.completions[0]).toMatchObject({ acceptedMode: 'prompt', deliveryId: 'delivery-1' })
    } finally {
      await handle.cleanup()
    }
  })
})
