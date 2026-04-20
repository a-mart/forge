import { SessionManager } from '@mariozechner/pi-coding-agent'
import type {
  RuntimeCreationOptions,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  SmartCompactResult,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime,
} from '../swarm/runtime-contracts.js'
import { SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'

export class FakeRuntime implements SwarmAgentRuntime {
  readonly runtimeType = 'pi' as const
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  private readonly systemPrompt: string

  terminateCalls: Array<RuntimeShutdownOptions | undefined> = []
  shutdownForReplacementCalls: Array<RuntimeShutdownOptions | undefined> = []
  stopInFlightCalls: Array<RuntimeShutdownOptions | undefined> = []
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  compactCalls: Array<string | undefined> = []
  smartCompactCalls: Array<string | undefined> = []
  recycleCalls = 0
  nextDeliveryId = 0
  busy = false
  contextRecoveryInProgress = false
  terminateMutatesDescriptorStatus = true
  sendMessageError: Error | undefined
  smartCompactResult: SmartCompactResult = { compacted: true }
  onSendMessage:
    | ((message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode) => Promise<void> | void)
    | undefined
  specialistFallbackReplayMessage: RuntimeUserMessage | undefined
  specialistFallbackReplaySnapshot: SpecialistFallbackReplaySnapshot | undefined
  specialistFallbackReplayError: Error | undefined

  constructor(descriptor: AgentDescriptor, systemPrompt = '') {
    this.descriptor = descriptor
    this.systemPrompt = systemPrompt
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return this.busy ? 1 : 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.descriptor.contextUsage
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  isContextRecoveryInProgress(): boolean {
    return this.contextRecoveryInProgress
  }

  async prepareForSpecialistFallbackReplay(): Promise<SpecialistFallbackReplaySnapshot | undefined> {
    if (this.specialistFallbackReplayError) {
      throw this.specialistFallbackReplayError
    }

    if (this.specialistFallbackReplaySnapshot) {
      return {
        messages: this.specialistFallbackReplaySnapshot.messages.map((message) => ({
          text: message.text,
          images: message.images?.map((image) => ({ ...image })) ?? [],
        })),
      }
    }

    if (!this.specialistFallbackReplayMessage) {
      return undefined
    }

    return {
      messages: [
        {
          text: this.specialistFallbackReplayMessage.text,
          images: this.specialistFallbackReplayMessage.images?.map((image) => ({ ...image })) ?? [],
        },
      ],
    }
  }

  async restorePreparedSpecialistFallbackReplay(): Promise<void> {}

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    await this.onSendMessage?.(message, delivery)

    if (this.sendMessageError) {
      throw this.sendMessageError
    }

    this.nextDeliveryId += 1
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as never)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: this.busy ? 'steer' : 'prompt',
    }
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push(customInstructions)
    return {
      status: 'ok',
      customInstructions: customInstructions ?? null,
    }
  }

  async smartCompact(customInstructions?: string): Promise<SmartCompactResult> {
    this.smartCompactCalls.push(customInstructions)
    return this.smartCompactResult
  }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.busy = false
    this.descriptor.status = 'idle'
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    this.terminateCalls.push(options)
    if (this.terminateMutatesDescriptorStatus) {
      this.descriptor.status = 'terminated'
    }
  }

  async shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void> {
    this.shutdownForReplacementCalls.push(options)
  }

  async recycle(): Promise<void> {
    this.recycleCalls += 1
  }

  getCustomEntries(customType: string): unknown[] {
    return this.sessionManager.getEntries()
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.sessionManager.appendCustomEntry(customType, data)
  }
}

export class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly createdRuntimeIds: string[] = []
  readonly runtimeCreationCountByAgentId = new Map<string, number>()
  readonly runtimeCreationOptionsByAgentId = new Map<string, RuntimeCreationOptions | undefined>()
  readonly systemPromptByAgentId = new Map<string, string>()
  readonly publishedToUserCalls: Array<{
    agentId: string
    text: string
    source: 'speak_to_user' | 'system'
    targetContext?: MessageTargetContext
  }> = []
  onCreateRuntime:
    | ((options: { descriptor: AgentDescriptor; runtime: FakeRuntime; creationCount: number; runtimeToken?: number }) => Promise<void> | void)
    | undefined

  override async publishToUser(
    agentId: string,
    text: string,
    source: 'speak_to_user' | 'system' = 'speak_to_user',
    targetContext?: MessageTargetContext,
  ): Promise<{ targetContext: MessageSourceContext }> {
    this.publishedToUserCalls.push({ agentId, text, source, targetContext })
    return super.publishToUser(agentId, text, source, targetContext)
  }

  async getMemoryRuntimeResourcesForTest(agentId = 'manager'): Promise<{
    memoryContextFile: { path: string; content: string }
    additionalSkillPaths: string[]
  }> {
    const descriptor = this.getAgent(agentId)
    if (!descriptor) {
      throw new Error(`Unknown test agent: ${agentId}`)
    }

    return this.getMemoryRuntimeResources(descriptor)
  }

  async getSwarmContextFilesForTest(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.getSwarmContextFiles(cwd)
  }

  getLoadedConversationAgentIdsForTest(): string[] {
    const state = this as unknown as {
      conversationEntriesByAgentId: Map<string, unknown>
    }

    return Array.from(state.conversationEntriesByAgentId.keys()).sort((left, right) => left.localeCompare(right))
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(structuredClone(descriptor), systemPrompt)
    const creationCount = (this.runtimeCreationCountByAgentId.get(descriptor.agentId) ?? 0) + 1

    this.runtimeCreationCountByAgentId.set(descriptor.agentId, creationCount)
    await this.onCreateRuntime?.({ descriptor, runtime, creationCount, runtimeToken })
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.runtimeCreationOptionsByAgentId.set(descriptor.agentId, options)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)

    return runtime
  }

  protected override async executeSessionMemoryLLMMerge(
    _descriptor: AgentDescriptor,
    _profileMemoryContent: string,
    _sessionMemoryContent: string,
  ): Promise<{ mergedContent: string; model: string }> {
    throw new Error('LLM merge disabled in tests')
  }
}

export async function bootWithDefaultManager(
  manager: SwarmManager & { runtimeByAgentId?: Map<string, FakeRuntime> },
  config: SwarmConfig,
  options: { clearBootstrapSendCalls?: boolean; callerAgentId?: string } = {},
): Promise<AgentDescriptor> {
  await manager.boot()
  const managerId = config.managerId ?? 'manager'
  const managerName = config.managerDisplayName ?? managerId

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  const callerAgentId =
    options.callerAgentId ??
    manager
      .listAgents()
      .find((descriptor) => descriptor.role === 'manager')
      ?.agentId ??
    managerId

  const createdManager = await manager.createManager(callerAgentId, {
    name: managerName,
    cwd: config.defaultCwd,
  })

  if (options.clearBootstrapSendCalls !== false) {
    const createdRuntime = manager.runtimeByAgentId?.get(createdManager.agentId)
    if (createdRuntime) {
      createdRuntime.sendCalls = []
      createdRuntime.nextDeliveryId = 0
    }
  }

  return createdManager
}
