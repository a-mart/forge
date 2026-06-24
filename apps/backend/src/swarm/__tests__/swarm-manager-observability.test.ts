import { describe, expect, it } from 'vitest'
import type { PhoenixObservabilitySettings, PhoenixObservabilitySettingsPatch, PhoenixObservabilityStatus, PhoenixObservabilityTestResponse } from '@forge/protocol'
import type {
  ObservabilityFacade,
  ObservabilityPromptResolvedInput,
  ObservabilityRuntimeCreatedInput,
  ObservabilityRuntimeInputCompletion,
  ObservabilityRuntimeInputHandle,
  ObservabilityRuntimeInputInput,
  ObservabilityRuntimeErrorInput,
  ObservabilityRuntimeSessionEventInput,
  ObservabilityToolSideEffectInput,
  ObservabilityUserVisibleMessageInput,
  ObservabilityAgentDeliveryInput,
} from '../../observability/observability-types.js'
import { createDefaultPhoenixObservabilitySettings } from '../../observability/observability-settings.js'
import type { RuntimeSessionEvent } from '../runtime-contracts.js'
import { createTempConfig } from '../../test-support/temp-config.js'
import { TestSwarmManager, bootWithDefaultManager } from '../../test-support/swarm-manager-harness.js'

type RuntimeControllerForTest = {
  allocateRuntimeToken(agentId: string): number
  getRuntimeToken(agentId: string): number | undefined
  handleRuntimeSessionEvent(runtimeToken: number, agentId: string, event: RuntimeSessionEvent): Promise<boolean>
}

class RecordingObservability implements ObservabilityFacade {
  readonly calls: string[] = []
  readonly runtimeInputs: ObservabilityRuntimeInputInput[] = []
  readonly completions: ObservabilityRuntimeInputCompletion[] = []
  readonly sessionEvents: ObservabilityRuntimeSessionEventInput[] = []
  readonly deliveries: ObservabilityAgentDeliveryInput[] = []
  readonly userVisibleMessages: ObservabilityUserVisibleMessageInput[] = []
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
    this.nextRoot += 1
    const handle = { rootTurnId: `root-${this.nextRoot}`, targetAgentId: input.targetAgentId, runtimeToken: input.runtimeToken }
    this.runtimeInputs.push({ ...input, rootTurnId: handle.rootTurnId })
    return handle
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
  recordRuntimeError(_input: ObservabilityRuntimeErrorInput): void {}
  recordToolSideEffect(_input: ObservabilityToolSideEffectInput): void {}
  recordUserVisibleMessage(input: ObservabilityUserVisibleMessageInput): void {
    this.calls.push('recordUserVisibleMessage')
    this.userVisibleMessages.push(input)
  }
  recordAgentDelivery(input: ObservabilityAgentDeliveryInput): void {
    this.calls.push('recordAgentDelivery')
    this.deliveries.push(input)
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
      observability.deliveries.length = 0
      const runtime = manager.runtimeByAgentId.get(descriptor.agentId)
      if (!runtime) throw new Error('expected test runtime')
      const runtimeController = (manager as unknown as { runtimeController: RuntimeControllerForTest }).runtimeController
      runtimeController.allocateRuntimeToken(descriptor.agentId)
      runtime.onSendMessage = async () => {
        const runtimeToken = runtimeController.getRuntimeToken(descriptor.agentId)
        if (runtimeToken === undefined) throw new Error('expected runtime token')
        await runtimeController.handleRuntimeSessionEvent(runtimeToken, descriptor.agentId, { type: 'turn_start' })
      }

      await manager.dispatchRuntimeUserMessage({
        targetAgentId: descriptor.agentId,
        text: 'hello before resolve',
        sourceContext: { channel: 'web' },
      })

      expect(observability.calls.indexOf('beginRuntimeInput')).toBeLessThan(observability.calls.indexOf('event:turn_start'))
      expect(observability.calls).toContain('completeRuntimeInput')
      expect(observability.runtimeInputs[0]).toMatchObject({ targetAgentId: descriptor.agentId, rootSource: 'user_input' })
      expect(observability.sessionEvents[0]?.runtimeToken).toBe(observability.runtimeInputs[0]?.runtimeToken)
      expect(observability.sessionEvents[0]?.runtimeToken).toBeTypeOf('number')
      expect(observability.completions[0]).toMatchObject({ acceptedMode: 'prompt', deliveryId: 'delivery-1' })
    } finally {
      await handle.cleanup()
    }
  })

  it('records assistant_output as a user-visible observability message on the active root turn', async () => {
    const handle = await createTempConfig({ prefix: 'forge-observability-assistant-output-' })
    try {
      const observability = new RecordingObservability()
      const manager = new TestSwarmManager(handle.config, { observability })
      const descriptor = await bootWithDefaultManager(manager, handle.config)
      observability.calls.length = 0
      observability.runtimeInputs.length = 0
      observability.completions.length = 0
      observability.sessionEvents.length = 0
      observability.deliveries.length = 0
      observability.userVisibleMessages.length = 0

      await manager.dispatchRuntimeUserMessage({
        targetAgentId: descriptor.agentId,
        text: 'normal final response please',
        sourceContext: { channel: 'web', messageId: 'user-message-1' },
      })

      const runtime = manager.runtimeByAgentId.get(descriptor.agentId)
      const runtimeMessage = runtime?.sendCalls.at(-1)?.message
      expect(typeof runtimeMessage).toBe('string')

      await (manager as unknown as {
        handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void>
      }).handleRuntimeSessionEvent(descriptor.agentId, {
        type: 'message_start',
        message: { role: 'user', content: runtimeMessage },
      })
      await (manager as unknown as {
        handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void>
      }).handleRuntimeSessionEvent(descriptor.agentId, {
        type: 'message_end',
        message: { role: 'assistant', content: 'Normal final response', stopReason: 'stop' },
      })
      await (manager as unknown as {
        handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void>
      }).handleRuntimeSessionEvent(descriptor.agentId, { type: 'turn_end', toolResults: [] })

      expect(observability.userVisibleMessages).toHaveLength(1)
      expect(observability.userVisibleMessages[0]).toMatchObject({
        agentId: descriptor.agentId,
        managerId: descriptor.agentId,
        role: 'manager',
        runtimeToken: observability.runtimeInputs[0]?.runtimeToken,
        rootTurnId: observability.runtimeInputs[0]?.rootTurnId,
        source: 'assistant_output',
        sourceContext: { channel: 'web', messageId: 'user-message-1' },
        text: 'Normal final response',
      })
      expect(observability.userVisibleMessages[0]?.messageId).toBeTypeOf('string')
    } finally {
      await handle.cleanup()
    }
  })

  it('records tool-correlated send-message delivery once with parent tool context', async () => {
    const handle = await createTempConfig({ prefix: 'forge-observability-tool-delivery-' })
    try {
      const observability = new RecordingObservability()
      const manager = new TestSwarmManager(handle.config, { observability })
      const descriptor = await bootWithDefaultManager(manager, handle.config)
      observability.deliveries.length = 0

      const worker = await manager.spawnAgent(descriptor.agentId, { agentId: 'worker-tool-delivery' })
      await manager.sendMessage(descriptor.agentId, worker.agentId, 'worker task from tool', 'auto', {
        observabilityParentTool: {
          agentId: descriptor.agentId,
          toolCallId: 'tool-call-1',
          toolName: 'send_message_to_agent',
        },
      })

      const deliveries = observability.deliveries.filter((entry) => entry.deliveryId === 'delivery-1')
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.parentTool).toMatchObject({
        agentId: descriptor.agentId,
        toolCallId: 'tool-call-1',
        toolName: 'send_message_to_agent',
      })
      expect(deliveries[0]?.parentTool).toBeDefined()
    } finally {
      await handle.cleanup()
    }
  })

  it('records direct manager-to-worker delivery spans with top-level parent root semantics', async () => {
    const handle = await createTempConfig({ prefix: 'forge-observability-delivery-' })
    try {
      const observability = new RecordingObservability()
      const manager = new TestSwarmManager(handle.config, { observability })
      const descriptor = await bootWithDefaultManager(manager, handle.config)
      observability.calls.length = 0
      observability.runtimeInputs.length = 0
      observability.completions.length = 0
      observability.sessionEvents.length = 0
      observability.deliveries.length = 0

      await manager.dispatchRuntimeUserMessage({
        targetAgentId: descriptor.agentId,
        text: 'delegate this',
        sourceContext: { channel: 'web' },
      })
      const userRoot = observability.runtimeInputs[0]?.rootTurnId
      const worker = await manager.spawnAgent(descriptor.agentId, { agentId: 'worker-one' })
      await manager.sendMessage(descriptor.agentId, worker.agentId, 'worker task', 'auto')

      const delivery = observability.deliveries.find((entry) => entry.targetAgentId === worker.agentId)
      expect(delivery).toMatchObject({
        fromAgentId: descriptor.agentId,
        targetAgentId: worker.agentId,
        requestedDelivery: 'auto',
        acceptedMode: 'prompt',
        source: 'internal',
        parentRootTurnId: userRoot,
      })
      expect(delivery?.rootTurnId).not.toBe(userRoot)
      expect(delivery?.metadata?.parentRootSemantics).toBe('top_level_root_turn')
    } finally {
      await handle.cleanup()
    }
  })
})
