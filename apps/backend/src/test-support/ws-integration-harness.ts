import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { vi } from 'vitest'
import type { SidebarPerfRecorder } from '../stats/sidebar-perf-types.js'
import { getGlobalForgeExtensionsDir } from '../swarm/data-paths.js'
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

// --- HTTP P0 route integration tests (SwarmWebSocketServer full stack) ---

export function createP0HttpRoutePerfStub(overrides?: Partial<SidebarPerfRecorder>): SidebarPerfRecorder {
  return {
    recordDuration: () => {},
    increment: () => {},
    readSummary: () => ({ histograms: {}, counters: {} }),
    readRecentSlowEvents: () => [],
    ...overrides,
  }
}

export interface P0HttpRouteSseEvent {
  event: string
  data: unknown
}

export class P0HttpRouteFakeSwarmManager extends EventEmitter {
  private readonly config: SwarmConfig
  private readonly agents: AgentDescriptor[]
  private readonly runtimeExtensionSnapshots: unknown[]
  private readonly forgeSettingsSnapshot: Record<string, unknown>
  private readonly perf: SidebarPerfRecorder
  readonly pooledCredentialAdds: Array<{ provider: string; credential: unknown; identity?: unknown }> = []

  constructor(
    config: SwarmConfig,
    agents: AgentDescriptor[],
    options?: { runtimeExtensionSnapshots?: unknown[]; forgeSettingsSnapshot?: Record<string, unknown>; perf?: SidebarPerfRecorder },
  ) {
    super()
    this.config = config
    this.agents = agents
    this.runtimeExtensionSnapshots = options?.runtimeExtensionSnapshots ?? []
    this.perf = options?.perf ?? createP0HttpRoutePerfStub()
    this.forgeSettingsSnapshot = options?.forgeSettingsSnapshot ?? {
      discovered: [],
      snapshots: [],
      recentErrors: [],
      directories: {
        global: getGlobalForgeExtensionsDir(config.paths.dataDir),
        profileTemplate: join(config.paths.dataDir, 'profiles', '<profileId>', 'extensions'),
        projectLocalRelative: '.forge/extensions',
      },
    }
  }

  getConfig(): SwarmConfig {
    return this.config
  }

  listAgents(): AgentDescriptor[] {
    return [...this.agents]
  }

  listBootstrapAgents(): AgentDescriptor[] {
    return [...this.agents]
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    return this.agents.find((agent) => agent.agentId === agentId)
  }

  listRuntimeExtensionSnapshots(): unknown[] {
    return this.runtimeExtensionSnapshots.map((snapshot) => ({ ...(snapshot as Record<string, unknown>) }))
  }

  async buildForgeExtensionSettingsSnapshot(): Promise<Record<string, unknown>> {
    return JSON.parse(JSON.stringify(this.forgeSettingsSnapshot)) as Record<string, unknown>
  }

  getConversationHistoryWithDiagnostics() {
    return {
      history: [],
      diagnostics: {
        cacheState: 'memory' as const,
        historySource: 'memory' as const,
        coldLoad: false,
        fsReadOps: 0,
        fsReadBytes: 0,
        detail: null,
      },
    }
  }

  getPendingChoiceIdsForSession(): string[] {
    return []
  }

  getSidebarPerfRecorder(): SidebarPerfRecorder {
    return this.perf
  }

  readSidebarPerfSummary() {
    return this.perf.readSummary()
  }

  readSidebarPerfSlowEvents() {
    return this.perf.readRecentSlowEvents()
  }

  async listSettingsAuth(): Promise<unknown[]> {
    return []
  }

  async listCredentialPool(provider: string): Promise<{ strategy: 'fill_first'; credentials: Array<Record<string, unknown>> }> {
    if (provider === 'openai-codex') {
      return {
        strategy: 'fill_first',
        credentials: [
          {
            id: 'cred-openai-primary',
            label: 'Primary Account',
            isPrimary: true,
            health: 'healthy',
            cooldownUntil: null,
            requestCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }
    }

    if (provider === 'anthropic') {
      return {
        strategy: 'fill_first',
        credentials: [],
      }
    }

    throw new Error(`Credential pooling is only supported for 'openai-codex', 'anthropic', got '${provider}'`)
  }

  async deleteSettingsAuth(_provider: string): Promise<void> {}

  async addPooledCredential(provider: string, credential: unknown, identity?: unknown): Promise<{ id: string }> {
    this.pooledCredentialAdds.push({ provider, credential, identity })
    return { id: `cred-${this.pooledCredentialAdds.length}` }
  }
}

export function createP0HttpRouteManagerDescriptor(rootDir: string, managerId = 'manager'): AgentDescriptor {
  return {
    agentId: managerId,
    displayName: 'Manager',
    role: 'manager',
    managerId,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: rootDir,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: join(rootDir, 'sessions', `${managerId}.jsonl`),
  }
}

export async function makeP0HttpRouteTempConfig(options?: { port?: number; managerId?: string }): Promise<SwarmConfig> {
  const config = await buildTempConfig({
    prefix: 'swarm-ws-p0-test-',
    port: options?.port,
    managerId: options?.managerId ?? 'manager',
    omitSharedAuthFile: true,
  })
  if (options != null && 'managerId' in options && options.managerId === undefined) {
    return { ...config, managerId: undefined }
  }
  return config
}

export function createP0HttpRouteIntegrationRegistryMock() {
  return Object.assign(new EventEmitter(), {
    getTelegramSnapshot: vi.fn(async () => ({ config: { enabled: false }, status: { state: 'disabled' } })),
    updateTelegramConfig: vi.fn(async () => ({ config: { enabled: true }, status: { state: 'connected' } })),
    disableTelegram: vi.fn(async () => ({ config: { enabled: false }, status: { state: 'disabled' } })),
    testTelegramConnection: vi.fn(async () => ({ ok: true })),
  })
}

export async function parseP0HttpRouteJsonResponse(response: Response): Promise<{ status: number; json: Record<string, unknown> }> {
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  }
}

export async function postP0HttpRouteTranscribe(url: string, options?: { size?: number; type?: string }): Promise<Response> {
  const byteLength = options?.size ?? 32
  const bytes = new Uint8Array(byteLength)
  bytes.fill(7)

  const form = new FormData()
  const file = new File([bytes], 'audio.wav', { type: options?.type ?? 'audio/wav' })
  form.set('file', file)

  return fetch(url, {
    method: 'POST',
    body: form,
  })
}

function parseP0HttpRouteSseChunk(chunk: string): P0HttpRouteSseEvent | undefined {
  const lines = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let event = 'message'
  let dataText = ''

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }

    if (line.startsWith('data:')) {
      dataText += line.slice('data:'.length).trim()
    }
  }

  if (!dataText) {
    return undefined
  }

  return {
    event,
    data: JSON.parse(dataText) as unknown,
  }
}

export async function readP0HttpRouteSseEvents(
  response: Response,
  onEvent?: (event: P0HttpRouteSseEvent) => Promise<void> | void,
): Promise<P0HttpRouteSseEvent[]> {
  if (!response.body) {
    throw new Error('Expected SSE response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: P0HttpRouteSseEvent[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    let boundaryIndex = buffer.indexOf('\n\n')
    while (boundaryIndex >= 0) {
      const chunk = buffer.slice(0, boundaryIndex)
      buffer = buffer.slice(boundaryIndex + 2)

      const parsed = parseP0HttpRouteSseChunk(chunk)
      if (parsed) {
        events.push(parsed)
        if (onEvent) {
          await onEvent(parsed)
        }
      }

      boundaryIndex = buffer.indexOf('\n\n')
    }
  }

  return events
}

export async function writeP0HttpRouteAuthKey(authFile: string, apiKey: string): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true })
  await writeFile(
    authFile,
    JSON.stringify(
      {
        'openai-codex': {
          type: 'api_key',
          key: apiKey,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
}
