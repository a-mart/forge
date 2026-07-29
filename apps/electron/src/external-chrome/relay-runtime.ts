import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { Socket } from 'node:net'
import path from 'node:path'
import {
  BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS,
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES,
  EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
  EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
  parseExternalChromeJsonRpcFrame,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResultByOperation,
  type BrowserEligibleTab,
  type BrowserTabSnapshot,
  type ExternalChromeFeatures,
  type ExternalChromeHelloParams,
  type ExternalChromeInventoryTab,
  type ExternalChromeJsonRpcMessage,
  type ExternalChromeLeaseChangedParams,
  type ExternalChromeRequestMethod,
  type ExternalChromeRequestParamsByMethod,
  type ExternalChromeResultByMethod,
} from '@forge/protocol'
import type { ExternalChromeTransport, ExternalChromeTransportResult } from '../browser/external-chrome-target-adapter.js'
import type { BrowserTargetSession, ExternalBrowserAcquireInput, ExternalBrowserAcquireResult, ExternalBrowserInventory, ExternalBrowserTargetAuthority } from '../browser/browser-target-adapter.js'

const MAX_RELAY_RECORD_BYTES = 384 * 1_024
const MAX_CONNECTIONS = 16
const MAX_PENDING_REQUESTS = 64
const HEARTBEAT_MS = 5_000
const CHECKPOINT_TTL_MS = 15 * 60_000
const MAX_LEASE_CHECKPOINTS = MAX_CONNECTIONS * 128
const MAX_CHECKPOINT_FILE_BYTES = 1 * 1_024 * 1_024
// NativeRpcClient retries the native port after 250 ms; one hello negotiation is
// bounded by its 10 s request timeout. Keep the automatic wait within that first
// reconnect attempt while still respecting the caller's browser deadline.
const RECONNECT_ACQUISITION_WAIT_MS = 11_000

interface RelayContext {
  epoch: string
  desktopInstanceId: string
  keyId: string
  secret: Buffer
}

export interface ExternalChromeRuntimeInventory {
  extensionInstanceId: string
  chromeVersion: string
  shellAbi: number
  payloadVersion: string
  payloadSha256?: string
  methods: ExternalChromeRequestMethod[]
  supportedOperations: BrowserAutomationOperation[]
  features: ExternalChromeFeatures
  connectedAt: string
}

export interface ExternalChromeLeaseCheckpoint {
  extensionInstanceId: string
  sessionAgentId: string
  profileId: string
  leaseId: string
  leaseEpoch: number
  tabIds: number[]
  expiresAt: number
}

interface PersistedCheckpoints {
  schemaVersion: 1
  leases: ExternalChromeLeaseCheckpoint[]
}

class LeaseCheckpointStore {
  private checkpoints: ExternalChromeLeaseCheckpoint[] = []
  private loaded = false
  private fatalLoadError: Error | null = null
  private operation: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}

  all(): Promise<ExternalChromeLeaseCheckpoint[]> {
    return this.serialize(async () => {
      await this.load()
      return structuredClone(this.checkpoints)
    })
  }

  put(checkpoint: ExternalChromeLeaseCheckpoint): Promise<void> {
    return this.serialize(async () => {
      await this.load()
      const withoutExact = this.checkpoints.filter((lease) => lease.extensionInstanceId !== checkpoint.extensionInstanceId || lease.leaseId !== checkpoint.leaseId || lease.leaseEpoch !== checkpoint.leaseEpoch)
      if (withoutExact.length >= MAX_LEASE_CHECKPOINTS) throw new Error('lease checkpoint bound reached')
      const next = [...withoutExact, structuredClone(checkpoint)]
      await this.persist(next)
      this.checkpoints = next
    })
  }

  remove(extensionInstanceId: string, leaseId: string, leaseEpoch: number): Promise<void> {
    return this.serialize(async () => {
      await this.load()
      const next = this.checkpoints.filter((lease) => lease.extensionInstanceId !== extensionInstanceId || lease.leaseId !== leaseId || lease.leaseEpoch !== leaseEpoch)
      await this.persist(next)
      this.checkpoints = next
    })
  }

  private serialize<Value>(work: () => Promise<Value>): Promise<Value> {
    const result = this.operation.then(work, work)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<void> {
    if (this.fatalLoadError !== null) throw this.fatalLoadError
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      if (Buffer.byteLength(raw) > MAX_CHECKPOINT_FILE_BYTES) throw new Error('lease checkpoint file exceeds bound')
      const value = JSON.parse(raw) as Partial<PersistedCheckpoints>
      if (value.schemaVersion !== 1 || !Array.isArray(value.leases)) throw new Error('lease checkpoint file has an invalid schema')
      // Persisted-only migration: acknowledged legacy transactions are discarded;
      // unresolved records retain only exact lease authority under the generic lifecycle.
      const migrated: ExternalChromeLeaseCheckpoint[] = []
      for (const lease of value.leases) {
        if (typeof lease === 'object' && lease !== null && !Array.isArray(lease) && Number.isFinite((lease as unknown as Record<string, unknown>).releasedAt)) continue
        const checkpoint = migrateCheckpoint(lease)
        if (checkpoint === null) throw new Error('lease checkpoint file contains an invalid record')
        migrated.push(checkpoint)
      }
      if (migrated.length > MAX_LEASE_CHECKPOINTS) throw new Error('lease checkpoint file exceeds authority bound')
      this.checkpoints = migrated
      this.loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.checkpoints = []
        this.loaded = true
        return
      }
      this.fatalLoadError = error instanceof Error ? error : new Error(String(error))
      throw this.fatalLoadError
    }
  }

  private async persist(checkpoints = this.checkpoints): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.new-${process.pid}-${randomUUID()}`
    const value: PersistedCheckpoints = { schemaVersion: 1, leases: checkpoints }
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, this.file)
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600)
  }
}

function migrateCheckpoint(value: unknown): ExternalChromeLeaseCheckpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.releasedAt !== undefined) return null
  if (typeof record.extensionInstanceId !== 'string' || typeof record.sessionAgentId !== 'string' ||
    typeof record.profileId !== 'string' || typeof record.leaseId !== 'string' || !Number.isSafeInteger(record.leaseEpoch) ||
    !Array.isArray(record.tabIds) || record.tabIds.length > 128 || !record.tabIds.every(Number.isSafeInteger) ||
    !Number.isFinite(record.expiresAt)) return null
  return {
    extensionInstanceId: record.extensionInstanceId,
    sessionAgentId: record.sessionAgentId,
    profileId: record.profileId,
    leaseId: record.leaseId,
    leaseEpoch: record.leaseEpoch as number,
    tabIds: [...record.tabIds] as number[],
    expiresAt: record.expiresAt as number,
  }
}

class FramedSocketPeer {
  private buffer = Buffer.alloc(0)
  private readonly queue: Record<string, unknown>[] = []
  private readonly waiters: Array<{ resolve: (value: Record<string, unknown> | null) => void; reject: (error: Error) => void }> = []
  private ended = false
  private queuedBytes = 0

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.push(chunk))
    socket.once('error', (error) => this.fail(error))
    socket.once('end', () => this.finish())
    socket.once('close', () => this.finish())
  }

  receive(): Promise<Record<string, unknown> | null> {
    const value = this.queue.shift()
    if (value) {
      this.queuedBytes -= Buffer.byteLength(JSON.stringify(value))
      return Promise.resolve(value)
    }
    if (this.ended) return Promise.resolve(null)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  async send(value: Record<string, unknown>): Promise<void> {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    if (payload.byteLength > MAX_RELAY_RECORD_BYTES) throw new Error('relay record exceeds bound')
    const frame = Buffer.allocUnsafe(payload.byteLength + 4)
    frame.writeUInt32LE(payload.byteLength, 0)
    payload.copy(frame, 4)
    await new Promise<void>((resolve, reject) => this.socket.write(frame, (error) => error ? reject(error) : resolve()))
  }

  close(): void { this.finish(); this.socket.destroy() }

  private push(chunk: Buffer): void {
    if (this.ended) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      while (this.buffer.byteLength >= 4) {
        const length = this.buffer.readUInt32LE(0)
        if (length === 0 || length > MAX_RELAY_RECORD_BYTES) throw new Error('invalid relay frame length')
        if (this.buffer.byteLength < length + 4) break
        const payload = this.buffer.subarray(4, length + 4)
        this.buffer = this.buffer.subarray(length + 4)
        const parsed = JSON.parse(payload.toString('utf8')) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('relay record must be an object')
        this.deliver(parsed as Record<string, unknown>, payload.byteLength)
      }
      if (this.buffer.byteLength > MAX_RELAY_RECORD_BYTES + 4) throw new Error('relay frame buffer exceeded bound')
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }

  private deliver(value: Record<string, unknown>, bytes: number): void {
    const waiter = this.waiters.shift()
    if (waiter) { waiter.resolve(value); return }
    if (this.queue.length >= 32 || this.queuedBytes + bytes > 2 * 1_024 * 1_024) {
      this.fail(new Error('relay receive queue exceeded bound'))
      return
    }
    this.queue.push(value)
    this.queuedBytes += bytes
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve(null)
  }

  private fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.socket.destroy()
  }
}

class RuntimeConnection {
  inventory: ExternalChromeRuntimeInventory | null = null
  private outboundSequence = 2
  private readonly pending = new Map<string, {
    method: ExternalChromeRequestMethod
    resolve: (value: ExternalChromeJsonRpcMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private requestSequence = 0
  private closed = false
  private firstLeaseReport = true

  constructor(
    private readonly peer: FramedSocketPeer,
    private readonly sessionKey: Buffer,
    private readonly context: Omit<RelayContext, 'secret'>,
    private readonly clientNonce: string,
    private readonly serverNonce: string,
    readonly maxMessageBytes: number,
    private readonly onHello: (connection: RuntimeConnection, hello: ExternalChromeHelloParams) => Promise<void>,
    private readonly onLeaseChanged: (connection: RuntimeConnection, change: ExternalChromeLeaseChangedParams) => Promise<void>,
    private readonly onClose: (connection: RuntimeConnection) => void,
  ) { void this.readLoop() }

  async request<Method extends ExternalChromeRequestMethod>(
    method: Method,
    params: ExternalChromeRequestParamsByMethod[Method],
    timeoutOverrideMs?: number,
  ): Promise<ExternalChromeResultByMethod[Method]> {
    if (this.closed) throw new Error('extension runtime is disconnected')
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error('extension request queue is full')
    const id = `desktop-${++this.requestSequence}-${randomUUID()}`.slice(0, 128)
    const requestedDeadline = method === 'forge.browser.execute' && typeof (params as { deadlineAt?: unknown }).deadlineAt === 'string'
      ? Date.parse((params as { deadlineAt: string }).deadlineAt)
      : Number.NaN
    const timeoutMs = timeoutOverrideMs !== undefined
      ? Math.max(1, Math.min(61_000, timeoutOverrideMs))
      : Number.isFinite(requestedDeadline)
        ? Math.max(1, Math.min(61_000, requestedDeadline - Date.now() + 250))
        : 10_000
    const response = await new Promise<ExternalChromeJsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      void this.sendPayload({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
    if ('error' in response) throw new Error(response.error.data?.code ?? response.error.message)
    if (!('result' in response)) throw new Error('extension returned an invalid response')
    return response.result as ExternalChromeResultByMethod[Method]
  }

  consumeFirstLeaseReport(): boolean {
    const first = this.firstLeaseReport
    this.firstLeaseReport = false
    return first
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.peer.close()
    this.sessionKey.fill(0)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('extension runtime disconnected')) }
    this.pending.clear()
    this.onClose(this)
  }

  private async readLoop(): Promise<void> {
    let inboundSequence = 2
    try {
      while (!this.closed) {
        const raw = await this.peer.receive()
        if (raw === null) break
        const record = verifyRecord(raw, this.sessionKey)
        if (record.type !== 'relay' || record.direction !== 'extension-to-desktop' || record.sequence !== inboundSequence++ ||
          record.epoch !== this.context.epoch || record.desktopInstanceId !== this.context.desktopInstanceId ||
          record.extensionOrigin !== EXTERNAL_CHROME_EXTENSION_ORIGIN || record.clientNonce !== this.clientNonce ||
          record.serverNonce !== this.serverNonce || record.protocolVersion !== 1 || typeof record.payload !== 'object' ||
          record.payload === null || Array.isArray(record.payload)) throw new Error('authenticated relay routing mismatch')
        await this.handlePayload(record.payload as Record<string, unknown>)
      }
    } catch { /* fail closed below */ }
    this.close()
  }

  private async handlePayload(payload: Record<string, unknown>): Promise<void> {
    const serialized = JSON.stringify(payload)
    if (Buffer.byteLength(serialized) > this.maxMessageBytes) throw new Error('extension payload exceeds negotiated bound')
    const id = typeof payload.id === 'string' ? payload.id : undefined
    const pending = id ? this.pending.get(id) : undefined
    const parsed = parseExternalChromeJsonRpcFrame(serialized, pending ? { expectedResponseMethod: pending.method, protocolVersion: 1 } : { protocolVersion: 1 })
    if (pending && !('method' in parsed)) {
      clearTimeout(pending.timer)
      this.pending.delete(id!)
      pending.resolve(parsed)
      return
    }
    if ('method' in parsed && !('id' in parsed)) {
      if (parsed.method === 'browser.leaseChanged') await this.onLeaseChanged(this, parsed.params)
      return
    }
    if (!('method' in parsed) || !('id' in parsed)) return
    if (parsed.method === 'forge.runtime.hello') {
      const hello = parsed.params as ExternalChromeHelloParams
      if (this.inventory !== null) throw new Error('duplicate runtime hello')
      if (hello.extensionId !== 'fcchfcnadajoejfbiclihglkmbcfhajd') throw new Error('runtime identity mismatch')
      this.inventory = {
        extensionInstanceId: hello.extensionInstanceId,
        chromeVersion: hello.chromeVersion,
        shellAbi: hello.shellAbi,
        payloadVersion: hello.payloadVersion,
        ...(hello.payloadSha256 ? { payloadSha256: hello.payloadSha256 } : {}),
        methods: hello.methods.filter((method): method is ExternalChromeRequestMethod => method.startsWith('forge.')),
        supportedOperations: hello.operations.filter((operation) => operation.supported).map((operation) => operation.operation),
        features: structuredClone(hello.features),
        connectedAt: new Date().toISOString(),
      }
      await this.sendPayload({ jsonrpc: '2.0', id: parsed.id, result: {
        protocolVersion: 1, desktopInstanceId: this.context.desktopInstanceId, heartbeatMs: HEARTBEAT_MS,
        maxMessageBytes: this.maxMessageBytes, requiredShellAbi: 1,
      } })
      await this.onHello(this, hello)
      return
    }
    if (parsed.method === 'forge.runtime.ping') {
      await this.sendPayload({ jsonrpc: '2.0', id: parsed.id, result: {
        protocolVersion: 1, nonce: parsed.params.nonce, receivedAt: new Date().toISOString(),
      } })
      return
    }
    await this.sendPayload({ jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Desktop does not accept this extension request' } })
  }

  private async sendPayload(payload: Record<string, unknown>): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(payload)) > this.maxMessageBytes) throw new Error('Desktop payload exceeds negotiated bound')
    const unsigned = {
      type: 'relay', direction: 'desktop-to-extension', epoch: this.context.epoch,
      desktopInstanceId: this.context.desktopInstanceId, extensionOrigin: EXTERNAL_CHROME_EXTENSION_ORIGIN,
      sequence: this.outboundSequence++, clientNonce: this.clientNonce, serverNonce: this.serverNonce,
      protocolVersion: 1, payload,
    }
    await this.peer.send(authenticateRecord(unsigned, this.sessionKey))
  }
}

type RuntimeRecovery = 'ready' | 'updating' | 'reconnecting' | 'manual-extension-reload' | 'incompatible-payload'

export type ExternalChromeLifecycleBarrierReason =
  | 'desktop-update'
  | 'desktop-quit'
  | 'user-disable'
  | 'integration-remove'
  | 'deployment-repair'
  | 'auth-rotation'
  | 'deployment-rollback'

interface RuntimeInstanceState {
  generation: number
  connection: RuntimeConnection
  recovery: RuntimeRecovery
  updateAttempt: Promise<void> | null
  preparedRuntimeKey: string | null
  reloadAttempt: Promise<void> | null
}

export class ExternalChromeRelayRuntime implements ExternalChromeTransport {
  readonly maxResponseBytes = EXTERNAL_CHROME_MAX_NEGOTIATED_MESSAGE_BYTES
  private context: RelayContext | null = null
  private readonly handshaking = new Set<FramedSocketPeer>()
  private readonly allConnections = new Set<RuntimeConnection>()
  private readonly connections = new Map<string, RuntimeConnection>()
  private readonly checkpoints: LeaseCheckpointStore
  private reconciliation: Promise<void> = Promise.resolve()
  private checkpointReleaseOperations: Promise<void> = Promise.resolve()
  private operationsQuiesced = true
  private expectedRuntime: { payloadVersion: string; sha256: string; shellAbi: number } | null = null
  private activateExpectedRuntime: (() => Promise<void>) | null = null
  private readonly instanceStates = new Map<string, RuntimeInstanceState>()
  private readonly instanceGenerations = new Map<string, number>()
  private updateBarrier: Promise<void> = Promise.resolve()
  private runtimeStateRevision = 0
  private observedStaleRuntimeKey: string | null = null
  private activatedRuntimeKey: string | null = null
  private failedActivationRuntimeKey: string | null = null
  private lifecycleBarrierRecovery: RuntimeRecovery | null = null
  private hadReadyConnection = false
  private readonly readinessWaiters = new Set<{ wake: () => void; cancel: () => void }>()
  /** Used only to choose the profile for explicit new-tab creation. */
  private readonly sessionAffinities = new Map<string, string>()
  /** One-shot acquisition metadata consumed by the immediately serialized open. */
  private readonly acquisitionCreated = new Map<string, boolean>()
  private transientOwnerEpoch = 1_000_000_000

  constructor(checkpointFile: string, private readonly now: () => number = Date.now) {
    this.checkpoints = new LeaseCheckpointStore(checkpointFile)
  }

  configureExpectedRuntime(
    runtime: { payloadVersion: string; sha256: string; shellAbi: number } | null,
    activate?: () => Promise<void>,
  ): void {
    const previousKey = this.expectedRuntimeKey()
    this.expectedRuntime = runtime === null ? null : { ...runtime }
    this.activateExpectedRuntime = activate ?? null
    const nextKey = this.expectedRuntimeKey()
    if (previousKey !== nextKey) {
      this.observedStaleRuntimeKey = null
      this.activatedRuntimeKey = null
      this.failedActivationRuntimeKey = null
      for (const state of this.instanceStates.values()) state.preparedRuntimeKey = null
    }
    this.runtimeStateRevision += 1
    for (const [extensionInstanceId, state] of this.instanceStates) {
      if (this.runtimeMatchesExpected(state.connection.inventory)) state.recovery = 'ready'
      else this.beginRuntimeUpdate(extensionInstanceId, state)
    }
    this.scheduleRuntimeUpdateBarrier()
  }

  recoveryStatus(): RuntimeRecovery {
    if (this.lifecycleBarrierRecovery !== null) return this.lifecycleBarrierRecovery
    const states = [...this.instanceStates.values()].map((state) => state.recovery)
    if (states.length === 0) return this.expectedRuntime === null ? 'ready' : 'reconnecting'
    for (const candidate of ['incompatible-payload', 'manual-extension-reload', 'updating', 'reconnecting'] as const) {
      if (states.includes(candidate)) return candidate
    }
    return 'ready'
  }

  activate(input: { epoch: string; desktopInstanceId: string; keyId: string; secret: Uint8Array }): void {
    this.deactivate()
    this.context = { ...input, secret: Buffer.from(input.secret) }
    this.operationsQuiesced = false
  }

  deactivate(): void {
    for (const peer of this.handshaking) peer.close()
    this.handshaking.clear()
    for (const connection of [...this.allConnections]) connection.close()
    this.allConnections.clear()
    this.connections.clear()
    this.instanceStates.clear()
    this.sessionAffinities.clear()
    this.acquisitionCreated.clear()
    this.runtimeStateRevision += 1
    this.cancelReadinessWaiters()
    this.context?.secret.fill(0)
    this.context = null
    this.operationsQuiesced = true
  }

  /**
   * Bounded Desktop lifecycle barrier. New authority is rejected synchronously
   * before the first await. Mutation callers may proceed only after every current
   * authenticated runtime prepared and every durable active checkpoint returned
   * an acknowledgement on its exact instance/lease/epoch connection.
   */
  async quiesce(reason: ExternalChromeLifecycleBarrierReason, deadlineAt: number): Promise<void> {
    this.operationsQuiesced = true
    this.lifecycleBarrierRecovery = 'updating'
    try {
      const barrierRevision = this.runtimeStateRevision
      const connections = [...this.connections.entries()]
      const preparation = await Promise.allSettled(connections.map(async ([extensionInstanceId, connection]) => {
        const inventory = connection.inventory
        if (!inventory || inventory.extensionInstanceId !== extensionInstanceId) throw new Error('runtime hello is incomplete')
        const target = this.expectedRuntime ?? (inventory.payloadSha256
          ? { payloadVersion: inventory.payloadVersion, sha256: inventory.payloadSha256, shellAbi: inventory.shellAbi }
          : null)
        if (!target) throw new Error('legacy runtime requires manual extension reload')
        if (this.now() >= deadlineAt) throw new Error('quiesce deadline elapsed before prepareUpdate')
        const result = await connection.request('forge.runtime.prepareUpdate', {
          protocolVersion: 1, payloadVersion: target.payloadVersion, sha256: target.sha256,
          deadlineAt: new Date(deadlineAt).toISOString(),
        }, Math.max(1, Math.floor((deadlineAt - this.now()) / 2)))
        if (this.connections.get(extensionInstanceId) !== connection || result.payloadVersion !== target.payloadVersion || result.quiesced !== true) {
          throw new Error('runtime returned a stale or mismatched prepareUpdate acknowledgement')
        }
      }))
      const checkpoints = await this.checkpoints.all()
      const releases = await Promise.allSettled(checkpoints.map(async (lease) => {
        const connection = this.connections.get(lease.extensionInstanceId)
        if (!connection) throw new Error('runtime disconnected before exact lease release')
        if (this.now() >= deadlineAt) throw new Error('quiesce deadline elapsed before exact lease release')
        const result = await connection.request('forge.browser.release', {
          protocolVersion: 1, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch, reason,
        }, Math.max(1, deadlineAt - this.now()))
        if (this.connections.get(lease.extensionInstanceId) !== connection ||
          result.leaseId !== lease.leaseId || result.leaseEpoch !== lease.leaseEpoch ||
          canonical([...result.releasedTabIds].sort((a, b) => a - b)) !== canonical(lease.tabIds)) {
          throw new Error('runtime release acknowledgement changed exact instance/lease authority')
        }
        if (this.now() >= deadlineAt) throw new Error('quiesce deadline elapsed during exact lease release')
        await this.checkpoints.remove(lease.extensionInstanceId, lease.leaseId, lease.leaseEpoch)
        for (const tabId of lease.tabIds) this.acquisitionCreated.delete(acquisitionKey(lease, tabId))
      }))
      const remaining = await this.checkpoints.all()
      const failures = [...preparation, ...releases].filter((result) => result.status === 'rejected')
      if (barrierRevision !== this.runtimeStateRevision || failures.length > 0 || remaining.length > 0) {
        throw new Error(`External Chrome quiesce could not prove release of ${remaining.length} lease(s)`)
      }
      this.lifecycleBarrierRecovery = null
    } catch (error) {
      this.lifecycleBarrierRecovery = 'manual-extension-reload'
      throw error
    }
  }

  async hasActiveLeaseCheckpoints(): Promise<boolean> {
    return (await this.checkpoints.all()).length > 0
  }

  accept(socket: Socket): void {
    if (!this.context || this.handshaking.size + this.allConnections.size >= MAX_CONNECTIONS) { socket.destroy(); return }
    const peer = new FramedSocketPeer(socket)
    this.handshaking.add(peer)
    void this.handshake(peer, this.context).catch(() => peer.close()).finally(() => this.handshaking.delete(peer))
  }

  inventory(): ExternalChromeRuntimeInventory[] {
    return [...this.connections.values()].flatMap((connection) => connection.inventory ? [structuredClone(connection.inventory)] : [])
      .sort((left, right) => left.extensionInstanceId.localeCompare(right.extensionInstanceId))
  }

  async ready(): Promise<void> {
    await this.checkpoints.all()
  }

  /** Opaque-only authority projection for trusted Desktop IPC recovery. */
  async leaseCheckpoints(): Promise<ExternalChromeLeaseCheckpoint[]> {
    await this.reconcileExpiredLeases()
    return this.checkpoints.all()
  }

  async endTurn(session: BrowserTargetSession, _turnId: string): Promise<void> {
    await this.releaseSessionCheckpoints(session, 'turn-ended')
  }

  async releaseSession(session: BrowserTargetSession, reason: string): Promise<void> {
    await this.releaseSessionCheckpoints(session, reason)
  }

  release(extensionInstanceId: string, leaseId: string, leaseEpoch: number, reason = 'released'): Promise<void> {
    return this.serializeCheckpointRelease(async () => {
      const checkpoint = (await this.checkpoints.all()).find((lease) => lease.extensionInstanceId === extensionInstanceId &&
        lease.leaseId === leaseId && lease.leaseEpoch === leaseEpoch)
      if (checkpoint) await this.releaseCheckpoint(checkpoint, reason)
    })
  }

  private releaseSessionCheckpoints(session: BrowserTargetSession, reason: string): Promise<void> {
    return this.serializeCheckpointRelease(async () => {
      const checkpoints = (await this.checkpoints.all()).filter((lease) =>
        lease.sessionAgentId === session.sessionAgentId && lease.profileId === session.profileId)
      for (const checkpoint of checkpoints) await this.releaseCheckpoint(checkpoint, reason)
    })
  }

  private async releaseCheckpoint(checkpoint: ExternalChromeLeaseCheckpoint, reason: string): Promise<void> {
    const connection = this.connection(checkpoint.extensionInstanceId)
    const result = await connection.request('forge.browser.release', {
      protocolVersion: 1, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch, reason,
    })
    if (this.connections.get(checkpoint.extensionInstanceId) !== connection || result.leaseId !== checkpoint.leaseId ||
      result.leaseEpoch !== checkpoint.leaseEpoch || canonical([...result.releasedTabIds].sort((a, b) => a - b)) !== canonical(checkpoint.tabIds)) {
      throw new Error('exact checkpoint release was not acknowledged')
    }
    await this.checkpoints.remove(checkpoint.extensionInstanceId, checkpoint.leaseId, checkpoint.leaseEpoch)
    for (const tabId of checkpoint.tabIds) this.acquisitionCreated.delete(acquisitionKey(checkpoint, tabId))
  }

  private serializeCheckpointRelease(work: () => Promise<void>): Promise<void> {
    const result = this.checkpointReleaseOperations.then(work, work)
    this.checkpointReleaseOperations = result.then(() => undefined, () => undefined)
    return result
  }

  async listEligibleTabs(session: BrowserTargetSession, deadlineAt?: number): Promise<ExternalBrowserInventory> {
    if (this.operationsQuiesced) return { tabs: [], truncated: false }
    if (this.readyConnectionIds().length === 0) await this.waitForReady(undefined, deadlineAt)
    const instances = this.readyConnectionIds()
    const outcomes = await Promise.allSettled(instances.map(async (extensionInstanceId) => {
      const connection = this.connection(extensionInstanceId)
      const result = await connection.request('forge.browser.inventory', {
        protocolVersion: 1,
        sessionAgentId: session.sessionAgentId,
      }, inventoryTimeout(deadlineAt))
      if (this.connections.get(extensionInstanceId) !== connection || !this.isInstanceReady(extensionInstanceId)) {
        throw new Error('inventory connection changed')
      }
      return {
        extensionInstanceId,
        connectedAt: connection.inventory?.connectedAt ?? new Date(0).toISOString(),
        tabs: result.tabs,
        truncated: result.truncated,
      }
    }))
    const ranked = outcomes.flatMap((outcome) => outcome.status === 'fulfilled'
      ? outcome.value.tabs.map((tab) => ({
          extensionInstanceId: outcome.value.extensionInstanceId,
          connectedAt: outcome.value.connectedAt,
          tab,
        }))
      : []).sort(compareRankedInventoryTabs)
    const publicTabs = ranked.slice(0, BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS)
      .map(({ extensionInstanceId, tab }) => publicInventoryTab(extensionInstanceId, tab))
    return {
      tabs: publicTabs,
      truncated: ranked.length > BROWSER_AUTOMATION_MAX_ELIGIBLE_TABS
        || outcomes.some((outcome) => outcome.status === 'rejected' || outcome.value.truncated),
    }
  }

  async acquireTarget(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult> {
    if (this.operationsQuiesced) return acquireFailure('runtime-not-ready', 'External Chrome is updating or reconnecting.', true)
    await this.reconcileExpiredLeases()
    const unresolved = (await this.checkpoints.all()).find((checkpoint) => checkpoint.sessionAgentId === input.sessionAgentId && checkpoint.profileId === input.profileId)
    if (unresolved) return acquireFailure('authority-conflict', 'Previous Chrome authority is still pending exact release.', true)

    const affinityKey = `${input.sessionAgentId}\0${input.profileId}`
    if (input.preferredTabId !== null && decodeTabId(input.preferredTabId) === null) {
      return acquireFailure('no-eligible-target', 'The requested Chrome inventory tab ID is invalid.', false)
    }
    let decoded = input.preferredTabId === null ? null : decodeTabId(input.preferredTabId)
    if (decoded === null && input.reuseExisting) {
      const inventory = await this.listEligibleTabs(input, input.deadlineAt)
      decoded = inventory.tabs[0] ? decodeTabId(inventory.tabs[0].tabId) : null
    }

    let extensionInstanceId = decoded?.extensionInstanceId
    if (extensionInstanceId !== undefined && !this.isInstanceReady(extensionInstanceId)) {
      await this.waitForReady(extensionInstanceId, input.deadlineAt)
      if (!this.isInstanceReady(extensionInstanceId)) return acquireFailure('runtime-not-ready', 'The selected Chrome profile is not ready.', true)
    }
    if (extensionInstanceId === undefined) {
      if (!input.createIfNeeded) return acquireFailure('no-eligible-target', 'No eligible Chrome tab is available.', true)
      if (this.operationsQuiesced) return acquireFailure('runtime-not-ready', 'External Chrome is not ready.', true)
      if (!input.reuseExisting && this.readyConnectionIds().length === 0) await this.waitForReady(undefined, input.deadlineAt)
      extensionInstanceId = this.preferredCreationInstance(affinityKey)
      if (extensionInstanceId === undefined) return acquireFailure('no-eligible-target', 'No ready Chrome profile is available.', true)
    }

    const leaseId = randomUUID()
    const leaseEpoch = input.ownerEpoch
    try {
      const acquired = await this.connection(extensionInstanceId).request('forge.browser.acquire', {
        protocolVersion: 1,
        sessionAgentId: input.sessionAgentId,
        leaseId,
        leaseEpoch,
        ...(decoded === null ? {} : { tabId: decoded.tabId }),
        createIfNeeded: decoded === null,
      })
      if (!matchesAcquisition(acquired, extensionInstanceId, input.sessionAgentId, leaseId, leaseEpoch)
        || decoded !== null && (acquired.tab.tabId !== decoded.tabId || acquired.created)
        || decoded === null && !acquired.created) {
        throw new Error('extension acquire response changed exact tab authority')
      }
      const tabId = acquired.tab.tabId
      if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('extension did not return one acquired tab')
      const checkpoint = {
        extensionInstanceId, sessionAgentId: input.sessionAgentId, profileId: input.profileId,
        leaseId, leaseEpoch, tabIds: [tabId], expiresAt: this.now() + CHECKPOINT_TTL_MS,
      }
      await this.checkpoints.put(checkpoint)
      this.acquisitionCreated.set(acquisitionKey(checkpoint, tabId), acquired.created)
      this.sessionAffinities.set(affinityKey, extensionInstanceId)
      return { ok: true, authority: { ownerEpoch: input.ownerEpoch, tabId: encodeTabId(extensionInstanceId, tabId) } }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'External Chrome acquisition failed.'
      const conflict = /lease|authority|debugger/u.test(message)
      return acquireFailure(conflict ? 'authority-conflict' : 'no-eligible-target', message, !conflict)
    }
  }

  async releaseAuthority(session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: string): Promise<void> {
    const decoded = decodeTabId(authority.tabId)
    if (decoded === null) throw new Error('stale tab authority')
    const checkpoint = (await this.checkpoints.all()).find((entry) => entry.extensionInstanceId === decoded.extensionInstanceId &&
      entry.sessionAgentId === session.sessionAgentId && entry.profileId === session.profileId && entry.leaseEpoch === authority.ownerEpoch &&
      entry.tabIds.length === 1 && entry.tabIds[0] === decoded.tabId)
    if (!checkpoint) throw new Error('exact tab release checkpoint is missing')
    await this.serializeCheckpointRelease(() => this.releaseCheckpoint(checkpoint, reason))
  }

  async revealTarget(session: BrowserTargetSession, tabId: string): Promise<{ revealed: true; tabId: string }> {
    const decoded = decodeTabId(tabId)
    if (!decoded || !this.isInstanceReady(decoded.extensionInstanceId)) throw new Error('The Chrome tab is no longer available.')
    const acquired = await this.acquireTarget({
      ...session,
      operation: 'status',
      preferredTabId: tabId,
      reuseExisting: true,
      createIfNeeded: false,
      ownerEpoch: ++this.transientOwnerEpoch,
    })
    if (!acquired.ok || acquired.authority.tabId !== tabId) throw new Error('The Chrome tab could not be reacquired for reveal.')
    try {
      const checkpoint = findCheckpoint(await this.activeCheckpoints(), tabId, session.sessionAgentId, session.profileId)
      if (!checkpoint) throw new Error('The Chrome reveal authority is unavailable.')
      const response = await this.connection(checkpoint.extensionInstanceId).request('forge.browser.reveal', {
        protocolVersion: 1,
        leaseId: checkpoint.leaseId,
        leaseEpoch: checkpoint.leaseEpoch,
        tabId: decoded.tabId,
      }, 5_000)
      if (response.leaseId !== checkpoint.leaseId || response.leaseEpoch !== checkpoint.leaseEpoch ||
        response.tabId !== decoded.tabId || response.revealed !== true) throw new Error('Chrome did not reveal the authorized tab.')
      return { revealed: true, tabId }
    } finally {
      await this.releaseAuthority(session, acquired.authority, 'reveal-complete')
    }
  }

  async execute(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    if (this.operationsQuiesced && request.operation !== 'status') return failure('extension-update-required', 'External Chrome is updating or reconnecting.', true)
    if (request.operation === 'status') return this.statusResult(request)
    if (request.operation === 'open') return this.openResult(request)
    if (request.operation === 'navigate') return this.navigateResult(request)
    if (['snapshot', 'click', 'type', 'press', 'scroll', 'evaluate', 'waitFor'].includes(request.operation)) {
      return this.functionalResult(request)
    }
    return failure('unsupported-operation', `External Chrome does not support ${request.operation}.`, false)
  }

  private async statusResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    const leases = await this.activeCheckpoints()
    const checkpoint = request.tabId ? findCheckpoint(leases, request.tabId, request.sessionAgentId, request.profileId) : undefined
    if (checkpoint && !this.isInstanceReady(checkpoint.extensionInstanceId)) await this.waitForReady(checkpoint.extensionInstanceId, Date.parse(request.deadlineAt))
    else if (!checkpoint && this.readyConnectionIds().length === 0) await this.waitForReady(undefined, Date.parse(request.deadlineAt))
    const checkpointReady = checkpoint ? this.isInstanceReady(checkpoint.extensionInstanceId) : false
    let selectedTab = checkpoint && request.tabId && checkpointReady ? checkpointTab(checkpoint, request.tabId, request, '', 'External Chrome tab') : null
    if (checkpoint && request.tabId && checkpointReady) {
      const decoded = decodeTabId(request.tabId)
      if (decoded && decoded.extensionInstanceId === checkpoint.extensionInstanceId && checkpoint.tabIds.includes(decoded.tabId)) {
        const response = await this.connection(checkpoint.extensionInstanceId).request('forge.browser.execute', {
          protocolVersion: 1, requestId: request.requestId, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
          tabId: decoded.tabId, operation: 'status', input: {}, deadlineAt: request.deadlineAt,
        })
        if (response.requestId !== request.requestId || response.leaseId !== checkpoint.leaseId || response.leaseEpoch !== checkpoint.leaseEpoch ||
          response.tabId !== decoded.tabId || response.operation !== 'status') return failure('lease-lost', 'Extension status changed authorized lease routing.', false)
        if (!response.ok) return { ok: false, error: response.error }
        const reported = response.result.selectedTab
        selectedTab = reported ? {
          ...reported, targetAffinity: 'external-chrome', tabId: request.tabId,
          sessionAgentId: request.sessionAgentId, profileId: request.profileId, controller: 'human', physicalVisible: false,
        } : null
      }
    }
    const readyConnectionIds = this.readyConnectionIds()
    const eligible = await this.listEligibleTabs(request, Date.parse(request.deadlineAt))
    const connectedAt = readyConnectionIds.flatMap((id) => {
      const inventory = this.connections.get(id)?.inventory
      return inventory ? [inventory.connectedAt] : []
    }).sort()[0] ?? null
    const result: BrowserAutomationResultByOperation['status'] = {
      available: readyConnectionIds.length > 0,
      host: {
        connected: readyConnectionIds.length > 0, hostId: request.hostId,
        hostGeneration: request.hostGeneration, focused: false, capabilities: null, connectedAt,
      },
      panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab,
      eligibleTabs: [...eligible.tabs], eligibleTabsTruncated: eligible.truncated,
    }
    return { ok: true, result, ...(selectedTab ? { updatedTab: selectedTab } : {}) }
  }

  private async openResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    const leases = await this.activeCheckpoints()
    if (request.tabId) {
      const existing = findCheckpoint(leases, request.tabId, request.sessionAgentId, request.profileId)
      if (!existing) return failure('target-not-found', 'The tab does not have current per-tab authority.', false)
      if (!this.isInstanceReady(existing.extensionInstanceId)) return failure('extension-update-required', 'The selected Chrome profile is updating or reconnecting.', true)
      const input = request.input as { url?: string }
      const tabId = decodeTabId(request.tabId)!.tabId
      return this.openCheckpoint(request, existing, tabId, input.url, this.consumeAcquisitionCreated(existing, tabId))
    }
    const input = request.input as { url?: string; reuseExistingTab: boolean }
    const acquired = await this.acquireTarget({
      sessionAgentId: request.sessionAgentId,
      profileId: request.profileId,
      operation: 'open',
      preferredTabId: null,
      reuseExisting: input.reuseExistingTab,
      createIfNeeded: true,
      deadlineAt: Date.parse(request.deadlineAt),
      ownerEpoch: ++this.transientOwnerEpoch,
    })
    if (!acquired.ok) return { ok: false, error: acquired.error }
    const checkpoint = findCheckpoint(
      await this.activeCheckpoints(), acquired.authority.tabId, request.sessionAgentId, request.profileId,
    )
    const decoded = decodeTabId(acquired.authority.tabId)
    if (!checkpoint || !decoded) return failure('lease-lost', 'Acquired Chrome authority checkpoint is unavailable.', false)
    return this.openCheckpoint(request, checkpoint, decoded.tabId, input.url, this.consumeAcquisitionCreated(checkpoint, decoded.tabId))
  }

  private async openCheckpoint(
    request: BrowserAutomationRequest,
    checkpoint: ExternalChromeLeaseCheckpoint,
    tabId: number,
    url?: string,
    created = false,
  ): Promise<ExternalChromeTransportResult> {
    const opaqueTabId = encodeTabId(checkpoint.extensionInstanceId, tabId)
    if (url) {
      const navigated = await this.navigateResult({
        ...request, operation: 'navigate', tabId: opaqueTabId,
        input: { url, readiness: 'load', timeoutMs: 30_000 },
      } as BrowserAutomationRequest)
      if (!navigated.ok) return navigated
      const tab = navigated.updatedTab!
      return { ok: true, result: { tab, created, panelRevealRequested: false }, updatedTab: tab }
    }
    const inspected = await this.statusResult({
      ...request, operation: 'status', tabId: opaqueTabId, input: {},
    } as BrowserAutomationRequest)
    if (!inspected.ok) return inspected
    const selected = (inspected.result as BrowserAutomationResultByOperation['status']).selectedTab
    const tab = selected ?? checkpointTab(checkpoint, opaqueTabId, request, '', 'External Chrome tab')
    return { ok: true, result: { tab, created, panelRevealRequested: false }, updatedTab: tab }
  }

  private async navigateResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    if (!request.tabId) return failure('target-not-found', 'Navigation requires an explicitly leased tab.', false)
    const checkpoint = findCheckpoint(await this.activeCheckpoints(), request.tabId, request.sessionAgentId, request.profileId)
    if (!checkpoint) return failure('lease-lost', 'The External Chrome lease is missing or stale.', true)
    const decoded = decodeTabId(request.tabId)
    if (!decoded || decoded.extensionInstanceId !== checkpoint.extensionInstanceId || !checkpoint.tabIds.includes(decoded.tabId)) {
      return failure('lease-lost', 'The tab is outside the authorized lease.', false)
    }
    const rawInput = request.input as Record<string, unknown>
    const { tabId: _tabId, ...input } = rawInput
    void _tabId
    const response = await this.connection(checkpoint.extensionInstanceId).request('forge.browser.execute', {
      protocolVersion: 1, requestId: request.requestId, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
      tabId: decoded.tabId, operation: 'navigate', input: input as { url?: string; environmentPort?: number; environmentProtocol?: 'http' | 'https'; path?: string; readiness: 'load' | 'domContentLoaded' | 'none'; timeoutMs: number }, deadlineAt: request.deadlineAt,
    })
    if (response.requestId !== request.requestId || response.leaseId !== checkpoint.leaseId ||
      response.leaseEpoch !== checkpoint.leaseEpoch || response.tabId !== decoded.tabId || response.operation !== 'navigate') {
      return failure('lease-lost', 'Extension response changed authorized lease routing.', false)
    }
    if (!response.ok) return { ok: false, error: response.error }
    const raw = response.result as BrowserAutomationResultByOperation['navigate']
    const tab = { ...raw.tab, targetAffinity: 'external-chrome' as const, tabId: request.tabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId }
    return { ok: true, result: { ...raw, tab }, updatedTab: tab }
  }

  private async functionalResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    if (!request.tabId) return failure('target-not-found', `${request.operation} requires an explicitly leased tab.`, false)
    const checkpoint = findCheckpoint(await this.activeCheckpoints(), request.tabId, request.sessionAgentId, request.profileId)
    if (!checkpoint) return failure('lease-lost', 'The External Chrome lease is missing or stale.', true)
    const decoded = decodeTabId(request.tabId)
    if (!decoded || decoded.extensionInstanceId !== checkpoint.extensionInstanceId || !checkpoint.tabIds.includes(decoded.tabId)) {
      return failure('lease-lost', 'The tab is outside the authorized lease.', false)
    }
    const rawInput = request.input as Record<string, unknown>
    const { tabId: _tabId, ...input } = rawInput
    void _tabId
    const response = await this.connection(checkpoint.extensionInstanceId).request('forge.browser.execute', {
      protocolVersion: 1, requestId: request.requestId, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
      tabId: decoded.tabId, operation: request.operation, input, deadlineAt: request.deadlineAt,
    } as ExternalChromeRequestParamsByMethod['forge.browser.execute'])
    if (response.requestId !== request.requestId || response.leaseId !== checkpoint.leaseId || response.leaseEpoch !== checkpoint.leaseEpoch ||
      response.tabId !== decoded.tabId || response.operation !== request.operation) {
      return failure('lease-lost', 'Extension response changed authorized lease routing.', false)
    }
    if (!response.ok) return { ok: false, error: response.error }
    const result = { ...(response.result as unknown as Record<string, unknown>), tabId: request.tabId } as BrowserAutomationResultByOperation[BrowserAutomationOperation]
    return { ok: true, result }
  }

  private async activeCheckpoints(): Promise<ExternalChromeLeaseCheckpoint[]> {
    await this.reconcileExpiredLeases()
    return (await this.checkpoints.all()).filter((lease) => lease.expiresAt > this.now())
  }

  private reconcileExpiredLeases(extensionInstanceId?: string): Promise<void> {
    const result = this.reconciliation.then(
      () => this.reconcileExpiredLeasesUnlocked(extensionInstanceId),
      () => this.reconcileExpiredLeasesUnlocked(extensionInstanceId),
    )
    this.reconciliation = result.then(() => undefined, () => undefined)
    return result
  }

  private async reconcileExpiredLeasesUnlocked(extensionInstanceId?: string): Promise<void> {
    const expired = (await this.checkpoints.all()).filter((lease) => lease.expiresAt <= this.now()
      && (extensionInstanceId === undefined || lease.extensionInstanceId === extensionInstanceId))
    for (const lease of expired) {
      const connection = this.connections.get(lease.extensionInstanceId)
      if (!connection) continue
      try {
        const result = await connection.request('forge.browser.release', {
          protocolVersion: 1, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch, reason: 'lease-expired',
        })
        if (result.leaseId === lease.leaseId && result.leaseEpoch === lease.leaseEpoch &&
          canonical([...result.releasedTabIds].sort((a, b) => a - b)) === canonical(lease.tabIds)) {
          await this.checkpoints.remove(lease.extensionInstanceId, lease.leaseId, lease.leaseEpoch)
          for (const tabId of lease.tabIds) this.acquisitionCreated.delete(acquisitionKey(lease, tabId))
        }
      } catch { /* retain checkpoint until acknowledged; never forget a possibly attached debugger */ }
    }
  }

  private connection(extensionInstanceId: string): RuntimeConnection {
    const connection = this.connections.get(extensionInstanceId)
    if (!connection) throw new Error('requested extension instance is disconnected')
    if (!this.isInstanceReady(extensionInstanceId)) throw new Error('extension-update-required')
    return connection
  }

  private isInstanceReady(extensionInstanceId: string): boolean {
    const state = this.instanceStates.get(extensionInstanceId)
    return state?.recovery === 'ready' && this.connections.get(extensionInstanceId) === state.connection
  }

  private readyConnectionIds(): string[] {
    return [...this.connections.keys()].filter((id) => this.isInstanceReady(id))
  }

  /**
   * A Chrome MV3 worker can briefly drop its native port while waking. Keep a
   * request in the automatic path alive for that bounded reconnect window
   * instead of treating the transient empty ready set as target absence.
   */
  private waitForReady(extensionInstanceId?: string, deadlineAt?: number): Promise<boolean> {
    const ready = (): boolean => extensionInstanceId === undefined
      ? this.readyConnectionIds().length > 0
      : this.isInstanceReady(extensionInstanceId)
    // A newly activated Desktop relay has no prior ready connection, but its
    // authenticated context proves that External Chrome is enabled. Wait in
    // that startup case; an inactive relay must remain an immediate no-op.
    if (ready() || (!this.hadReadyConnection && this.context === null)) return Promise.resolve(ready())
    const remaining = Number.isFinite(deadlineAt)
      ? Math.min(RECONNECT_ACQUISITION_WAIT_MS, Math.max(0, (deadlineAt as number) - Date.now()))
      : RECONNECT_ACQUISITION_WAIT_MS
    if (remaining <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => finish(false), remaining)
      timer.unref?.()
      const waiter = {
        wake: (): void => { if (ready()) finish(true) },
        cancel: (): void => finish(false),
      }
      const finish = (value: boolean): void => {
        if (timer === null) return
        clearTimeout(timer)
        timer = null
        this.readinessWaiters.delete(waiter)
        resolve(value)
      }
      this.readinessWaiters.add(waiter)
      waiter.wake()
    })
  }

  private notifyReadinessChanged(): void {
    for (const waiter of [...this.readinessWaiters]) waiter.wake()
  }

  private cancelReadinessWaiters(): void {
    for (const waiter of [...this.readinessWaiters]) waiter.cancel()
  }

  private consumeAcquisitionCreated(checkpoint: ExternalChromeLeaseCheckpoint, tabId: number): boolean {
    const key = acquisitionKey(checkpoint, tabId)
    const created = this.acquisitionCreated.get(key) ?? false
    this.acquisitionCreated.delete(key)
    return created
  }

  private preferredCreationInstance(affinityKey: string): string | undefined {
    const affinity = this.sessionAffinities.get(affinityKey)
    if (affinity !== undefined && this.isInstanceReady(affinity)) return affinity
    return this.readyConnectionIds().sort((left, right) => {
      const leftConnected = this.connections.get(left)?.inventory?.connectedAt ?? ''
      const rightConnected = this.connections.get(right)?.inventory?.connectedAt ?? ''
      return rightConnected.localeCompare(leftConnected) || left.localeCompare(right)
    })[0]
  }

  private runtimeMatchesExpected(inventory: ExternalChromeRuntimeInventory | null): boolean {
    // The authenticated pre-M5 hello remains parseable for update/recovery, but
    // its missing immutable payload identity can never authorize operations.
    if (inventory === null || inventory.payloadSha256 === undefined) return false
    return this.expectedRuntime === null ? inventory.shellAbi === 1 : (
      inventory.payloadVersion === this.expectedRuntime.payloadVersion &&
      inventory.payloadSha256 === this.expectedRuntime.sha256 &&
      inventory.shellAbi === this.expectedRuntime.shellAbi
    )
  }

  private beginRuntimeUpdate(extensionInstanceId: string, state: RuntimeInstanceState): void {
    if (state.updateAttempt !== null || state.reloadAttempt !== null) return
    const inventory = state.connection.inventory
    if (!inventory) return
    if (this.expectedRuntime === null) {
      state.recovery = inventory.shellAbi === 1 ? 'manual-extension-reload' : 'incompatible-payload'
      return
    }
    const runtimeKey = this.expectedRuntimeKey()
    if (runtimeKey === null) return
    this.observedStaleRuntimeKey = runtimeKey
    if (inventory.shellAbi !== this.expectedRuntime.shellAbi) {
      state.recovery = 'incompatible-payload'
      return
    }
    const hasAutomaticUpdate = inventory.methods.includes('forge.runtime.prepareUpdate') && inventory.methods.includes('forge.runtime.reload')
    if (!hasAutomaticUpdate) {
      state.recovery = 'manual-extension-reload'
      return
    }
    state.recovery = 'updating'
    state.preparedRuntimeKey = null
    const expected = { ...this.expectedRuntime }
    const generation = state.generation
    const connection = state.connection
    const current = (): boolean => {
      const latest = this.instanceStates.get(extensionInstanceId)
      return latest?.generation === generation && latest.connection === connection && this.expectedRuntimeKey() === runtimeKey
    }
    const attempt = (async () => {
      const prepared = await connection.request('forge.runtime.prepareUpdate', {
        protocolVersion: 1, payloadVersion: expected.payloadVersion, sha256: expected.sha256,
        deadlineAt: new Date(this.now() + 10_000).toISOString(),
      })
      if (prepared.payloadVersion !== expected.payloadVersion || prepared.quiesced !== true) throw new Error('prepareUpdate acknowledgement changed payload identity')
      if (!current()) return
      state.preparedRuntimeKey = runtimeKey
      this.runtimeStateRevision += 1
      if (this.activatedRuntimeKey === runtimeKey) this.beginRuntimeReload(extensionInstanceId, state, runtimeKey)
      else this.scheduleRuntimeUpdateBarrier()
    })().catch(() => {
      if (current()) state.recovery = 'manual-extension-reload'
    }).finally(() => {
      if (current() && state.updateAttempt === attempt) state.updateAttempt = null
    })
    state.updateAttempt = attempt
  }

  private expectedRuntimeKey(): string | null {
    return this.expectedRuntime === null
      ? null
      : `${this.expectedRuntime.shellAbi}:${this.expectedRuntime.payloadVersion}:${this.expectedRuntime.sha256}`
  }

  private scheduleRuntimeUpdateBarrier(): void {
    const evaluation = this.updateBarrier.then(
      () => this.evaluateRuntimeUpdateBarrier(),
      () => this.evaluateRuntimeUpdateBarrier(),
    )
    this.updateBarrier = evaluation.then(() => undefined, () => undefined)
  }

  private async evaluateRuntimeUpdateBarrier(): Promise<void> {
    const runtimeKey = this.expectedRuntimeKey()
    if (runtimeKey === null || this.observedStaleRuntimeKey !== runtimeKey ||
      this.activatedRuntimeKey === runtimeKey || this.failedActivationRuntimeKey === runtimeKey) return
    const revision = this.runtimeStateRevision
    const checkpoints = await this.checkpoints.all()
    if (revision !== this.runtimeStateRevision || runtimeKey !== this.expectedRuntimeKey()) {
      this.scheduleRuntimeUpdateBarrier()
      return
    }
    // A disconnected profile with durable lease authority is not absence proof.
    // Selector/native authority cannot move until that exact profile reconnects
    // and prepares, or its checkpoint is explicitly released.
    if (checkpoints.some((checkpoint) => !this.connections.has(checkpoint.extensionInstanceId))) return
    const stale = [...this.instanceStates.entries()].filter(([, state]) => !this.runtimeMatchesExpected(state.connection.inventory))
    if (stale.some(([, state]) => state.preparedRuntimeKey !== runtimeKey)) return

    try {
      await this.activateExpectedRuntime?.()
    } catch {
      if (runtimeKey === this.expectedRuntimeKey()) {
        this.failedActivationRuntimeKey = runtimeKey
        for (const [, state] of stale) {
          if (state.preparedRuntimeKey === runtimeKey) state.recovery = 'manual-extension-reload'
        }
      }
      return
    }
    if (runtimeKey !== this.expectedRuntimeKey()) return
    this.activatedRuntimeKey = runtimeKey
    for (const [extensionInstanceId, state] of this.instanceStates) {
      if (state.preparedRuntimeKey === runtimeKey && !this.runtimeMatchesExpected(state.connection.inventory)) {
        this.beginRuntimeReload(extensionInstanceId, state, runtimeKey)
      }
    }
  }

  private beginRuntimeReload(extensionInstanceId: string, state: RuntimeInstanceState, runtimeKey: string): void {
    if (state.reloadAttempt !== null || this.expectedRuntime === null || this.activatedRuntimeKey !== runtimeKey) return
    const expected = { ...this.expectedRuntime }
    const generation = state.generation
    const connection = state.connection
    const current = (): boolean => {
      const latest = this.instanceStates.get(extensionInstanceId)
      return latest?.generation === generation && latest.connection === connection && this.expectedRuntimeKey() === runtimeKey
    }
    const attempt = connection.request('forge.runtime.reload', {
      protocolVersion: 1, payloadVersion: expected.payloadVersion, sha256: expected.sha256,
    }).then((reloaded) => {
      if (reloaded.payloadVersion !== expected.payloadVersion || reloaded.accepted !== true) throw new Error('runtime.reload acknowledgement changed payload identity')
      if (current()) state.recovery = 'reconnecting'
    }).catch(() => {
      if (current()) state.recovery = 'manual-extension-reload'
    }).finally(() => {
      if (current() && state.reloadAttempt === attempt) state.reloadAttempt = null
    })
    state.reloadAttempt = attempt
  }

  private async handshake(peer: FramedSocketPeer, context: RelayContext): Promise<void> {
    const hello = await peer.receive()
    if (!hello || hello.type !== 'hello' || hello.sequence !== 0 || hello.epoch !== context.epoch ||
      hello.desktopInstanceId !== context.desktopInstanceId || hello.extensionOrigin !== EXTERNAL_CHROME_EXTENSION_ORIGIN ||
      typeof hello.clientNonce !== 'string' || hello.clientProtocolMin !== 1 || hello.clientProtocolMax !== 1 ||
      hello.desktopProtocolMin !== EXTERNAL_CHROME_PROTOCOL_MIN_VERSION || hello.desktopProtocolMax !== EXTERNAL_CHROME_PROTOCOL_MAX_VERSION ||
      typeof hello.maxMessageBytes !== 'number') throw new Error('relay hello did not match rendezvous')
    const maxMessageBytes = Math.min(256 * 1_024, hello.maxMessageBytes)
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) throw new Error('invalid relay message bound')
    const serverNonce = randomBytes(32).toString('base64url')
    const challengeFields = {
      type: 'challenge', sequence: 0, epoch: context.epoch, desktopInstanceId: context.desktopInstanceId,
      extensionOrigin: EXTERNAL_CHROME_EXTENSION_ORIGIN, clientNonce: hello.clientNonce, serverNonce,
      clientProtocolMin: 1, clientProtocolMax: 1, desktopProtocolMin: 1, desktopProtocolMax: 1,
      protocolVersion: 1, maxMessageBytes,
    }
    await peer.send({ ...challengeFields, proof: handshakeProof('desktop-challenge', challengeFields, context.secret) })
    const authentication = await peer.receive()
    if (!authentication) throw new Error('relay authentication missing')
    const { proof, ...authenticationFields } = authentication
    const expectedAuthentication = { ...challengeFields, type: 'authenticate', sequence: 1 }
    if (canonical(authenticationFields) !== canonical(expectedAuthentication)) throw new Error('relay authentication transcript mismatch')
    verifyProof(proof, handshakeProof('native-host-authenticate', expectedAuthentication, context.secret))
    const sessionKey = deriveSessionKey(challengeFields, context.secret)
    try {
      await peer.send(authenticateRecord({
        type: 'ready', epoch: context.epoch, desktopInstanceId: context.desktopInstanceId,
        extensionOrigin: EXTERNAL_CHROME_EXTENSION_ORIGIN, sequence: 1, clientNonce: hello.clientNonce,
        serverNonce, protocolVersion: 1, maxMessageBytes,
      }, sessionKey))
      const connection = new RuntimeConnection(peer, sessionKey, {
        epoch: context.epoch, desktopInstanceId: context.desktopInstanceId, keyId: context.keyId,
      }, hello.clientNonce, serverNonce, maxMessageBytes,
        async (connection, runtimeHello) => {
          const extensionInstanceId = runtimeHello.extensionInstanceId
          const previous = this.connections.get(extensionInstanceId)
          if (previous && previous !== connection) previous.close()
          const generation = (this.instanceGenerations.get(extensionInstanceId) ?? 0) + 1
          this.instanceGenerations.set(extensionInstanceId, generation)
          this.connections.set(extensionInstanceId, connection)
          const state: RuntimeInstanceState = {
            generation,
            connection,
            recovery: this.runtimeMatchesExpected(connection.inventory) ? 'ready' : 'reconnecting',
            updateAttempt: null,
            preparedRuntimeKey: null,
            reloadAttempt: null,
          }
          this.instanceStates.set(extensionInstanceId, state)
          this.runtimeStateRevision += 1
          if (state.recovery === 'ready') this.hadReadyConnection = true
          this.notifyReadinessChanged()
          if (state.recovery === 'ready') {
            const reconciliation = setTimeout(() => { void this.reconcileExpiredLeases(extensionInstanceId) }, 0)
            reconciliation.unref?.()
          } else {
            this.beginRuntimeUpdate(extensionInstanceId, state)
          }
          this.scheduleRuntimeUpdateBarrier()
        },
        async (connection, change) => {
          const extensionInstanceId = connection.inventory?.extensionInstanceId
          if (!extensionInstanceId) return
          const existing = (await this.checkpoints.all()).find((lease) => lease.extensionInstanceId === extensionInstanceId && lease.leaseId === change.leaseId && lease.leaseEpoch === change.leaseEpoch)
          connection.consumeFirstLeaseReport()
          // Unknown extension-originated authority is never adopted. Desktop is the
          // sole automatic acquisition initiator; reconnect may only prove exact CAS state.
          if (!existing) return
          if (canonical(existing.tabIds) !== canonical([...change.tabIds].sort((a, b) => a - b))) {
            throw new Error('reconnect authority proof attempted to change exact per-tab scope')
          }
          // A release notification proves Extension state but not delivery of the
          // request acknowledgement. Retain the checkpoint so the idempotent exact
          // release can be retried and acknowledged across disconnects.
        },
        (connection) => {
          this.allConnections.delete(connection)
          const id = connection.inventory?.extensionInstanceId
          if (id && this.connections.get(id) === connection) {
            this.connections.delete(id)
            const state = this.instanceStates.get(id)
            if (state?.connection === connection) {
              this.instanceStates.delete(id)
              this.runtimeStateRevision += 1
              this.notifyReadinessChanged()
              this.scheduleRuntimeUpdateBarrier()
            }
          }
        })
      this.allConnections.add(connection)
    } catch (error) { sessionKey.fill(0); throw error }
  }
}

interface RankedInventoryTab {
  extensionInstanceId: string
  connectedAt: string
  tab: ExternalChromeInventoryTab
}

function compareRankedInventoryTabs(left: RankedInventoryTab, right: RankedInventoryTab): number {
  return Number(right.tab.active) - Number(left.tab.active)
    || Number(right.tab.windowFocused) - Number(left.tab.windowFocused)
    || right.tab.lastAccessed - left.tab.lastAccessed
    || right.connectedAt.localeCompare(left.connectedAt)
    || left.extensionInstanceId.localeCompare(right.extensionInstanceId)
    || left.tab.windowId - right.tab.windowId
    || left.tab.tabId - right.tab.tabId
}

function publicInventoryTab(extensionInstanceId: string, tab: ExternalChromeInventoryTab): BrowserEligibleTab {
  const lastAccessed = Math.min(8_640_000_000_000_000, Math.max(0, tab.lastAccessed))
  return {
    targetAffinity: 'external-chrome',
    tabId: encodeTabId(extensionInstanceId, tab.tabId),
    browserProfileId: `ext-profile.${extensionInstanceId}`,
    windowId: `ext-window.${extensionInstanceId}.${tab.windowId}`,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowFocused: tab.windowFocused,
    lastAccessedAt: new Date(lastAccessed).toISOString(),
  }
}

function inventoryTimeout(deadlineAt?: number): number {
  return Number.isFinite(deadlineAt) ? Math.max(1, Math.min(5_000, (deadlineAt as number) - Date.now())) : 5_000
}

function encodeTabId(extensionInstanceId: string, tabId: number): string { return `ext.${extensionInstanceId}.${tabId}` }
function decodeTabId(value: string): { extensionInstanceId: string; tabId: number } | null {
  const match = /^ext\.([A-Za-z0-9_-]{1,128})\.([0-9]+)$/u.exec(value)
  if (!match) return null
  const tabId = Number(match[2])
  return Number.isSafeInteger(tabId) ? { extensionInstanceId: match[1]!, tabId } : null
}
function acquisitionKey(checkpoint: ExternalChromeLeaseCheckpoint, tabId: number): string {
  return `${checkpoint.extensionInstanceId}\0${checkpoint.leaseId}\0${checkpoint.leaseEpoch}\0${tabId}`
}
function findCheckpoint(leases: ExternalChromeLeaseCheckpoint[], opaqueTabId: string, sessionAgentId: string, profileId: string): ExternalChromeLeaseCheckpoint | undefined {
  const decoded = decodeTabId(opaqueTabId)
  return decoded ? leases.find((lease) => lease.extensionInstanceId === decoded.extensionInstanceId && lease.tabIds.includes(decoded.tabId) && lease.sessionAgentId === sessionAgentId && lease.profileId === profileId) : undefined
}
function matchesAcquisition(
  result: ExternalChromeResultByMethod['forge.browser.acquire'],
  extensionInstanceId: string,
  sessionAgentId: string,
  leaseId: string,
  leaseEpoch: number,
): boolean {
  return result.extensionInstanceId === extensionInstanceId && result.sessionAgentId === sessionAgentId &&
    result.leaseId === leaseId && result.leaseEpoch === leaseEpoch
}
function checkpointTab(_checkpoint: ExternalChromeLeaseCheckpoint, opaqueTabId: string, request: BrowserAutomationRequest, url: string, title: string): BrowserTabSnapshot {
  const now = new Date().toISOString()
  return {
    targetAffinity: 'external-chrome', tabId: opaqueTabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url, title, lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false,
    zoomFactor: 1, controller: 'human', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' },
    renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
  }
}
function failure(
  code: BrowserAutomationFailure['code'],
  message: string,
  retryable: boolean,
  details?: Record<string, string | number | boolean | null>,
): ExternalChromeTransportResult {
  return { ok: false, error: { code, message, retryable, ...(details ? { details } : {}) } }
}

function acquireFailure(
  fallbackReason: 'runtime-not-ready' | 'authority-conflict' | 'no-eligible-target',
  message: string,
  retryable: boolean,
): ExternalBrowserAcquireResult {
  return {
    ok: false,
    error: { code: fallbackReason === 'authority-conflict' ? 'lease-conflict' : 'target-not-found', message: message.slice(0, 1_024), retryable },
    metadata: { phase: 'acquisition', mutationState: 'not-started', fallbackReason },
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new Error('non-JSON relay value')
}
function hmac(key: Uint8Array, domain: string, value: Record<string, unknown>): string {
  return createHmac('sha256', key).update(domain).update('\0').update(canonical(value)).digest('base64url')
}
function handshakeProof(role: string, fields: Record<string, unknown>, key: Uint8Array): string { return hmac(key, `forge-external-chrome/handshake/v1/${role}`, fields) }
function verifyProof(actual: unknown, expected: string): void {
  if (typeof actual !== 'string') throw new Error('missing authentication proof')
  const left = Buffer.from(actual, 'base64url'); const right = Buffer.from(expected, 'base64url')
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) throw new Error('authentication failed')
}
function deriveSessionKey(challenge: Record<string, unknown>, secret: Uint8Array): Buffer {
  const transcript = Buffer.from(canonical(challenge))
  const salt = createHmac('sha256', secret).update('forge-external-chrome/session-salt/v1\0').update(transcript).digest()
  try { return Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from('forge-external-chrome/relay-record-key/v1'), 32)) }
  finally { transcript.fill(0); salt.fill(0) }
}
function authenticateRecord(record: Record<string, unknown>, key: Uint8Array): Record<string, unknown> {
  return { ...record, mac: hmac(key, 'forge-external-chrome/relay-record/v1', record) }
}
function verifyRecord(record: Record<string, unknown>, key: Uint8Array): Record<string, unknown> {
  const { mac, ...unsigned } = record
  verifyProof(mac, hmac(key, 'forge-external-chrome/relay-record/v1', unsigned))
  return record
}
