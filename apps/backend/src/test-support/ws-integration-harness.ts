import { SessionManager } from '@mariozechner/pi-coding-agent'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-contracts.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import { bootWithDefaultManager } from './swarm-manager-harness.js'
import { makeTempConfig as buildTempConfig } from './temp-config.js'

/** Minimal fake runtime used by `ws-server.test.ts` and colocated HTTP route integration tests. */
export class WsServerTestFakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  compactCalls: Array<string | undefined> = []
  sendCalls: Array<{ message: string; delivery: RequestedDeliveryMode }> = []
  terminateCalls = 0
  recycleCalls = 0
  stopInFlightCalls: Array<{ abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number } | undefined> = []
  stopInFlightImpl?: (options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }) => Promise<void>
  terminateImpl?: (options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }) => Promise<void>

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  async sendMessage(message: string, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: 'fake-delivery',
      acceptedMode: 'prompt',
    }
  }

  async terminate(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.terminateCalls += 1
    if (this.terminateImpl) {
      await this.terminateImpl(options)
    }
  }

  async recycle(): Promise<void> {
    this.recycleCalls += 1
  }

  async stopInFlight(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.stopInFlightCalls.push(options)
    if (this.stopInFlightImpl) {
      await this.stopInFlightImpl(options)
      return
    }

    this.descriptor.status = 'idle'
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push(customInstructions)
    return {
      status: 'ok',
      customInstructions: customInstructions ?? null,
    }
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries()
    return entries
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.sessionManager.appendCustomEntry(customType, data)
  }
}

export class WsServerTestSwarmManager extends SwarmManager {
  pickedDirectoryPath: string | null = null
  lastPickedDirectoryDefaultPath: string | undefined
  readonly runtimeByAgentId = new Map<string, WsServerTestFakeRuntime>()

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    _systemPrompt?: string,
    _runtimeToken?: number,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new WsServerTestFakeRuntime(descriptor)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    return runtime as unknown as SwarmAgentRuntime
  }

  override async pickDirectory(defaultPath?: string): Promise<string | null> {
    this.lastPickedDirectoryDefaultPath = defaultPath
    return this.pickedDirectoryPath
  }
}

export async function makeWsServerTempConfig(port: number, allowNonManagerSubscriptions = false): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-ws-test-',
    port,
    allowNonManagerSubscriptions,
  })
}

export async function bootWsServerTestManager(
  manager: WsServerTestSwarmManager,
  config: SwarmConfig,
): Promise<AgentDescriptor> {
  return bootWithDefaultManager(manager as unknown as Parameters<typeof bootWithDefaultManager>[0], config, {
    clearBootstrapSendCalls: false,
  })
}
