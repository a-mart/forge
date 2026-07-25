import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { Socket } from 'node:net'
import path from 'node:path'
import {
  EXTERNAL_CHROME_EXTENSION_ORIGIN,
  EXTERNAL_CHROME_MAX_MESSAGE_BYTES,
  EXTERNAL_CHROME_PROTOCOL_MAX_VERSION,
  EXTERNAL_CHROME_PROTOCOL_MIN_VERSION,
  parseExternalChromeJsonRpcFrame,
  type BrowserAutomationFailure,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResultByOperation,
  type BrowserTabSnapshot,
  type ExternalChromeChildPolicy,
  type ExternalChromeFeatures,
  type ExternalChromeHelloParams,
  type ExternalChromeJsonRpcMessage,
  type ExternalChromeLeaseChangedParams,
  type ExternalChromeRequestMethod,
  type ExternalChromeRequestParamsByMethod,
  type ExternalChromeResultByMethod,
} from '@forge/protocol'
import type { ExternalChromeTransport, ExternalChromeTransportResult } from '../browser/external-chrome-target-adapter.js'

const MAX_RELAY_RECORD_BYTES = 384 * 1_024
const MAX_CONNECTIONS = 16
const MAX_PENDING_REQUESTS = 64
const HEARTBEAT_MS = 5_000
const CHECKPOINT_TTL_MS = 15 * 60_000

interface RelayContext {
  epoch: string
  desktopInstanceId: string
  keyId: string
  secret: Buffer
}

export interface ExternalChromeRuntimeInventory {
  extensionInstanceId: string
  profileAlias?: string
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
  groupId: number | null
  childPolicy: ExternalChromeChildPolicy
  expiresAt: number
  /** Durable proof that Extension acknowledged detach; retained until backend lifecycle finalize. */
  releasedAt?: number
  /** Opaque two-phase transaction authority. Never contains tab metadata. */
  lifecycleReleaseId?: string
  originalHostId?: string
  originalHostGeneration?: number
  /** Idempotency marker while Extension retains a detached same-lease HANDOFF. */
  handoffTurnId?: string
}

interface PersistedCheckpoints {
  schemaVersion: 1
  leases: ExternalChromeLeaseCheckpoint[]
  /** Bounded idempotency receipts, not lease authority and never picker-visible. */
  finalizedReleaseIds?: string[]
}

class LeaseCheckpointStore {
  private checkpoints: ExternalChromeLeaseCheckpoint[] = []
  private finalizedReleaseIds: string[] = []
  private loaded = false
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
      this.checkpoints = this.checkpoints.filter((lease) => lease.extensionInstanceId !== checkpoint.extensionInstanceId || lease.leaseId !== checkpoint.leaseId || lease.leaseEpoch !== checkpoint.leaseEpoch)
      this.checkpoints.push(structuredClone(checkpoint))
      if (this.checkpoints.length > 128) this.checkpoints.splice(0, this.checkpoints.length - 128)
      await this.persist()
    })
  }

  remove(extensionInstanceId: string, leaseId: string, leaseEpoch: number): Promise<void> {
    return this.serialize(async () => {
      await this.load()
      this.checkpoints = this.checkpoints.filter((lease) => lease.extensionInstanceId !== extensionInstanceId || lease.leaseId !== leaseId || lease.leaseEpoch !== leaseEpoch)
      await this.persist()
    })
  }

  finalizeLifecycleRelease(input: {
    extensionInstanceId: string; sessionAgentId: string; profileId: string; leaseId: string; leaseEpoch: number;
    lifecycleReleaseId: string; originalHostId: string; originalHostGeneration: number
  }): Promise<void> {
    return this.serialize(async () => {
      await this.load()
      const transaction = this.checkpoints.find((lease) => lease.lifecycleReleaseId === input.lifecycleReleaseId)
      if (!transaction) {
        if (this.finalizedReleaseIds.includes(input.lifecycleReleaseId)) return
        throw new Error('stale lifecycle release authority')
      }
      if (transaction.releasedAt === undefined || transaction.extensionInstanceId !== input.extensionInstanceId ||
        transaction.sessionAgentId !== input.sessionAgentId || transaction.profileId !== input.profileId ||
        transaction.leaseId !== input.leaseId || transaction.leaseEpoch !== input.leaseEpoch ||
        transaction.originalHostId !== input.originalHostId || transaction.originalHostGeneration !== input.originalHostGeneration) {
        throw new Error('stale lifecycle release authority')
      }
      this.checkpoints = this.checkpoints.filter((lease) => lease !== transaction)
      this.finalizedReleaseIds = [...this.finalizedReleaseIds.filter((id) => id !== input.lifecycleReleaseId), input.lifecycleReleaseId].slice(-256)
      await this.persist()
    })
  }

  wasLifecycleReleaseFinalized(lifecycleReleaseId: string): Promise<boolean> {
    return this.serialize(async () => {
      await this.load()
      return this.finalizedReleaseIds.includes(lifecycleReleaseId)
    })
  }

  removePendingForExtension(extensionInstanceId: string): Promise<void> {
    return this.serialize(async () => {
      await this.load()
      this.checkpoints = this.checkpoints.filter((lease) => lease.extensionInstanceId !== extensionInstanceId || lease.sessionAgentId !== '__local_pending__')
      await this.persist()
    })
  }

  private serialize<Value>(work: () => Promise<Value>): Promise<Value> {
    const result = this.operation.then(work, work)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      if (Buffer.byteLength(raw) > 64 * 1_024) return
      const value = JSON.parse(raw) as Partial<PersistedCheckpoints>
      if (value.schemaVersion !== 1 || !Array.isArray(value.leases)) return
      this.checkpoints = value.leases.filter(validCheckpoint).slice(-128)
      this.finalizedReleaseIds = Array.isArray(value.finalizedReleaseIds)
        ? value.finalizedReleaseIds.filter(validLifecycleReleaseId).slice(-256)
        : []
    } catch { this.checkpoints = [] }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.new-${process.pid}-${randomUUID()}`
    const value: PersistedCheckpoints = {
      schemaVersion: 1, leases: this.checkpoints,
      ...(this.finalizedReleaseIds.length > 0 ? { finalizedReleaseIds: this.finalizedReleaseIds } : {}),
    }
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, this.file)
    if (process.platform !== 'win32') await fs.chmod(this.file, 0o600)
  }
}

function validLifecycleReleaseId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:@/-]+$/u.test(value)
}

function validCheckpoint(value: unknown): value is ExternalChromeLeaseCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Partial<ExternalChromeLeaseCheckpoint>
  return typeof record.extensionInstanceId === 'string' && typeof record.sessionAgentId === 'string' &&
    typeof record.profileId === 'string' && typeof record.leaseId === 'string' && Number.isSafeInteger(record.leaseEpoch) &&
    Array.isArray(record.tabIds) && record.tabIds.length <= 128 && record.tabIds.every(Number.isSafeInteger) &&
    (record.groupId === null || Number.isSafeInteger(record.groupId)) &&
    (record.childPolicy === 'manual' || record.childPolicy === 'include-opened-by-leased-tabs') && Number.isFinite(record.expiresAt) &&
    (record.releasedAt === undefined || Number.isFinite(record.releasedAt)) &&
    ((record.lifecycleReleaseId === undefined && record.originalHostId === undefined && record.originalHostGeneration === undefined) ||
      (validLifecycleReleaseId(record.lifecycleReleaseId) &&
        typeof record.originalHostId === 'string' && record.originalHostId.length > 0 && record.originalHostId.length <= 128 &&
        Number.isSafeInteger(record.originalHostGeneration) && (record.originalHostGeneration as number) > 0)) &&
    (record.handoffTurnId === undefined || validLifecycleReleaseId(record.handoffTurnId))
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
        ...(hello.profileAlias ? { profileAlias: hello.profileAlias } : {}),
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
  | 'authority-takeover'

interface RuntimeInstanceState {
  generation: number
  connection: RuntimeConnection
  recovery: RuntimeRecovery
  updateAttempt: Promise<void> | null
  preparedRuntimeKey: string | null
  reloadAttempt: Promise<void> | null
}

export class ExternalChromeRelayRuntime implements ExternalChromeTransport {
  readonly maxResponseBytes = EXTERNAL_CHROME_MAX_MESSAGE_BYTES
  private context: RelayContext | null = null
  private readonly handshaking = new Set<FramedSocketPeer>()
  private readonly allConnections = new Set<RuntimeConnection>()
  private readonly connections = new Map<string, RuntimeConnection>()
  private readonly checkpoints: LeaseCheckpointStore
  private reconciliation: Promise<void> = Promise.resolve()
  private lifecycleReleaseOperations: Promise<void> = Promise.resolve()
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
    this.runtimeStateRevision += 1
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
      const checkpoints = (await this.checkpoints.all()).filter((lease) => lease.releasedAt === undefined)
      const releases = await Promise.allSettled(checkpoints.map(async (lease) => {
        const connection = this.connections.get(lease.extensionInstanceId)
        if (!connection) throw new Error('runtime disconnected before exact lease release')
        if (this.now() >= deadlineAt) throw new Error('quiesce deadline elapsed before exact lease release')
        const result = await connection.request('forge.browser.release', {
          protocolVersion: 1, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch, reason,
        }, Math.max(1, deadlineAt - this.now()))
        if (this.connections.get(lease.extensionInstanceId) !== connection ||
          result.leaseId !== lease.leaseId || result.leaseEpoch !== lease.leaseEpoch) {
          throw new Error('runtime release acknowledgement changed exact instance/lease authority')
        }
        if (this.now() >= deadlineAt) throw new Error('quiesce deadline elapsed during exact lease release')
        await this.checkpoints.remove(lease.extensionInstanceId, lease.leaseId, lease.leaseEpoch)
      }))
      const remaining = (await this.checkpoints.all()).filter((lease) => lease.releasedAt === undefined)
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
    return (await this.checkpoints.all()).some((lease) => lease.releasedAt === undefined)
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
      .map((entry, index) => ({ ...entry, profileAlias: entry.profileAlias ?? `Chrome profile ${index + 1}` }))
  }

  async ready(): Promise<void> {
    await this.checkpoints.all()
  }

  /** Opaque-only authority projection for trusted Desktop IPC recovery. */
  async leaseCheckpoints(): Promise<ExternalChromeLeaseCheckpoint[]> {
    await this.reconcileExpiredLeases()
    return this.checkpoints.all()
  }

  async listCandidates(extensionInstanceId: string, sessionAgentId: string): Promise<ExternalChromeResultByMethod['forge.browser.listCandidates']> {
    this.assertAcceptingOperations()
    return this.connection(extensionInstanceId).request('forge.browser.listCandidates', { protocolVersion: 1, sessionAgentId })
  }

  async claim(input: {
    extensionInstanceId: string; sessionAgentId: string; profileId: string; leaseId: string; leaseEpoch: number;
    tabIds: number[]; groupId?: number; childPolicy: ExternalChromeChildPolicy
  }): Promise<ExternalChromeResultByMethod['forge.browser.claim']> {
    this.assertAcceptingOperations()
    const result = await this.connection(input.extensionInstanceId).request('forge.browser.claim', {
      protocolVersion: 1, sessionAgentId: input.sessionAgentId, leaseId: input.leaseId, leaseEpoch: input.leaseEpoch,
      tabIds: input.tabIds, ...(input.groupId === undefined ? {} : { groupId: input.groupId }), childPolicy: input.childPolicy,
    })
    const expectedTabs = [...input.tabIds].sort((a, b) => a - b)
    const returnedTabs = result.tabs.map((tab) => tab.tabId).sort((a, b) => a - b)
    if (result.extensionInstanceId !== input.extensionInstanceId || result.sessionAgentId !== input.sessionAgentId ||
      result.leaseId !== input.leaseId || result.leaseEpoch !== input.leaseEpoch || result.groupId !== (input.groupId ?? null) ||
      result.childPolicy !== input.childPolicy || canonical(expectedTabs) !== canonical(returnedTabs)) {
      throw new Error('extension claim response did not match the authorized compare-and-set scope')
    }
    await this.checkpoints.put({
      extensionInstanceId: input.extensionInstanceId, sessionAgentId: input.sessionAgentId, profileId: input.profileId,
      leaseId: input.leaseId, leaseEpoch: input.leaseEpoch, tabIds: [...input.tabIds].sort((a, b) => a - b),
      groupId: input.groupId ?? null, childPolicy: input.childPolicy, expiresAt: this.now() + CHECKPOINT_TTL_MS,
    })
    return result
  }

  async handoffSessionAtTurnEnd(input: {
    extensionInstanceId: string; sessionAgentId: string; profileId: string; tabId: number; turnId: string
  }): Promise<void> {
    const checkpoint = (await this.checkpoints.all()).find((lease) => lease.releasedAt === undefined &&
      lease.extensionInstanceId === input.extensionInstanceId && lease.sessionAgentId === input.sessionAgentId &&
      lease.profileId === input.profileId && lease.tabIds.includes(input.tabId))
    if (!checkpoint) throw new Error('turn disposition used stale lease authority')
    await this.turnEnded({
      extensionInstanceId: checkpoint.extensionInstanceId, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
      turnId: input.turnId, finalTabs: [], handoffTabs: checkpoint.tabIds,
    })
  }

  async turnEnded(input: {
    extensionInstanceId: string; leaseId: string; leaseEpoch: number; turnId: string; finalTabs: number[]; handoffTabs: number[]
  }): Promise<ExternalChromeResultByMethod['forge.browser.turnEnded']> {
    const checkpoint = (await this.checkpoints.all()).find((lease) => lease.extensionInstanceId === input.extensionInstanceId &&
      lease.leaseId === input.leaseId && lease.leaseEpoch === input.leaseEpoch && lease.releasedAt === undefined)
    if (!checkpoint) throw new Error('turn disposition used stale lease authority')
    if (checkpoint.handoffTurnId !== undefined) {
      if (checkpoint.handoffTurnId !== input.turnId || input.finalTabs.length !== 0 || canonical(input.handoffTabs) !== canonical(checkpoint.tabIds)) {
        throw new Error('turn disposition is stale or out of order for the retained handoff')
      }
      return {
        protocolVersion: 1, leaseId: input.leaseId, leaseEpoch: input.leaseEpoch, turnId: input.turnId,
        releasedTabs: [], handoffTabs: [...checkpoint.tabIds],
      }
    }
    const requested = [...input.finalTabs, ...input.handoffTabs].sort((a, b) => a - b)
    if (new Set(requested).size !== requested.length || canonical(requested) !== canonical(checkpoint.tabIds)) {
      throw new Error('turn disposition changed the compare-and-set lease scope')
    }
    const result = await this.connection(input.extensionInstanceId).request('forge.browser.turnEnded', {
      protocolVersion: 1, leaseId: input.leaseId, leaseEpoch: input.leaseEpoch, turnId: input.turnId,
      finalTabs: input.finalTabs, handoffTabs: input.handoffTabs,
    })
    if (result.leaseId !== input.leaseId || result.leaseEpoch !== input.leaseEpoch || result.turnId !== input.turnId ||
      canonical([...result.releasedTabs].sort((a, b) => a - b)) !== canonical([...input.finalTabs].sort((a, b) => a - b)) ||
      canonical([...result.handoffTabs].sort((a, b) => a - b)) !== canonical([...input.handoffTabs].sort((a, b) => a - b))) {
      throw new Error('extension turn response changed authorized dispositions')
    }
    if (input.handoffTabs.length === 0) await this.checkpoints.remove(input.extensionInstanceId, input.leaseId, input.leaseEpoch)
    else await this.checkpoints.put({
      ...checkpoint, tabIds: [...input.handoffTabs].sort((a, b) => a - b),
      handoffTurnId: input.turnId, expiresAt: Math.min(checkpoint.expiresAt, this.now() + 2 * 60_000),
    })
    return result
  }

  release(extensionInstanceId: string, leaseId: string, leaseEpoch: number, reason = 'released'): Promise<void> {
    return this.serializeLifecycleRelease(async () => {
      const checkpoint = (await this.checkpoints.all()).find((lease) => lease.extensionInstanceId === extensionInstanceId
        && lease.leaseId === leaseId && lease.leaseEpoch === leaseEpoch)
      if (checkpoint?.releasedAt === undefined) {
        const result = await this.connection(extensionInstanceId).request('forge.browser.release', { protocolVersion: 1, leaseId, leaseEpoch, reason })
        if (result.leaseId !== leaseId || result.leaseEpoch !== leaseEpoch) throw new Error('extension release response changed lease routing')
      }
      if (checkpoint?.lifecycleReleaseId) await this.checkpoints.put({ ...checkpoint, releasedAt: checkpoint.releasedAt ?? this.now() })
      else await this.checkpoints.remove(extensionInstanceId, leaseId, leaseEpoch)
    })
  }

  prepareLifecycleRelease(input: {
    extensionInstanceId: string; sessionAgentId: string; profileId: string; tabId: number; lifecycleReleaseId: string;
    originalHostId: string; originalHostGeneration: number; reason: string
  }): Promise<void> {
    return this.serializeLifecycleRelease(() => this.prepareLifecycleReleaseUnlocked(input))
  }

  finalizeLifecycleRelease(input: {
    extensionInstanceId: string; sessionAgentId: string; profileId: string; tabId: number; lifecycleReleaseId: string;
    originalHostId: string; originalHostGeneration: number
  }): Promise<void> {
    return this.serializeLifecycleRelease(async () => {
      const checkpoints = await this.checkpoints.all()
      const transaction = checkpoints.find((lease) => lease.lifecycleReleaseId === input.lifecycleReleaseId)
      if (!transaction) {
        if (await this.checkpoints.wasLifecycleReleaseFinalized(input.lifecycleReleaseId)) return
        throw new Error('stale lifecycle release authority')
      }
      if (!transaction.tabIds.includes(input.tabId)) throw new Error('stale lifecycle release tab authority')
      await this.checkpoints.finalizeLifecycleRelease({
        extensionInstanceId: input.extensionInstanceId, sessionAgentId: input.sessionAgentId, profileId: input.profileId,
        leaseId: transaction.leaseId, leaseEpoch: transaction.leaseEpoch, lifecycleReleaseId: input.lifecycleReleaseId,
        originalHostId: input.originalHostId, originalHostGeneration: input.originalHostGeneration,
      })
    })
  }

  private serializeLifecycleRelease(work: () => Promise<void>): Promise<void> {
    const result = this.lifecycleReleaseOperations.then(work, work)
    this.lifecycleReleaseOperations = result.then(() => undefined, () => undefined)
    return result
  }

  private async prepareLifecycleReleaseUnlocked(input: {
    extensionInstanceId: string; sessionAgentId: string; profileId: string; tabId: number; lifecycleReleaseId: string;
    originalHostId: string; originalHostGeneration: number; reason: string
  }): Promise<void> {
    if (await this.checkpoints.wasLifecycleReleaseFinalized(input.lifecycleReleaseId)) throw new Error('stale lifecycle release authority')
    const checkpoints = await this.checkpoints.all()
    let transaction = checkpoints.find((lease) => lease.lifecycleReleaseId === input.lifecycleReleaseId)
    if (transaction) {
      if (transaction.extensionInstanceId !== input.extensionInstanceId || transaction.sessionAgentId !== input.sessionAgentId ||
        transaction.profileId !== input.profileId || !transaction.tabIds.includes(input.tabId) ||
        transaction.originalHostId !== input.originalHostId || transaction.originalHostGeneration !== input.originalHostGeneration) {
        throw new Error('stale lifecycle release authority')
      }
      if (transaction.releasedAt !== undefined) return
    } else {
      transaction = checkpoints.find((lease) => lease.releasedAt === undefined && lease.extensionInstanceId === input.extensionInstanceId &&
        lease.sessionAgentId === input.sessionAgentId && lease.profileId === input.profileId && lease.tabIds.includes(input.tabId))
        ?? checkpoints.find((lease) => lease.releasedAt !== undefined && lease.lifecycleReleaseId === undefined &&
          lease.extensionInstanceId === input.extensionInstanceId && lease.sessionAgentId === input.sessionAgentId &&
          lease.profileId === input.profileId && lease.tabIds.includes(input.tabId))
      if (!transaction || transaction.lifecycleReleaseId !== undefined) throw new Error('stale lifecycle release authority')
      transaction = {
        ...transaction, lifecycleReleaseId: input.lifecycleReleaseId,
        originalHostId: input.originalHostId, originalHostGeneration: input.originalHostGeneration,
      }
      await this.checkpoints.put(transaction)
      if (transaction.releasedAt !== undefined) return
    }
    const result = await this.connection(input.extensionInstanceId).request('forge.browser.release', {
      protocolVersion: 1, leaseId: transaction.leaseId, leaseEpoch: transaction.leaseEpoch, reason: input.reason,
    })
    if (result.leaseId !== transaction.leaseId || result.leaseEpoch !== transaction.leaseEpoch) {
      throw new Error('extension release response changed lease routing')
    }
    await this.checkpoints.put({ ...transaction, releasedAt: this.now() })
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
        await this.markCheckpointResumed(checkpoint)
        if (!response.ok) return { ok: false, error: response.error }
        const reported = response.result.selectedTab
        selectedTab = reported ? {
          ...reported, hostKind: 'external-chrome', tabId: request.tabId,
          sessionAgentId: request.sessionAgentId, profileId: request.profileId, controller: 'human', physicalVisible: false,
        } : null
      }
    }
    const readyConnectionIds = this.readyConnectionIds()
    const connectedAt = readyConnectionIds.flatMap((id) => {
      const inventory = this.connections.get(id)?.inventory
      return inventory ? [inventory.connectedAt] : []
    }).sort()[0] ?? null
    const result: BrowserAutomationResultByOperation['status'] = {
      available: readyConnectionIds.length > 0,
      host: {
        hostKind: 'external-chrome', connected: readyConnectionIds.length > 0, hostId: request.hostId,
        hostGeneration: request.hostGeneration, focused: false, capabilities: null, connectedAt,
      },
      panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab,
    }
    return { ok: true, result, ...(selectedTab ? { updatedTab: selectedTab } : {}) }
  }

  private async openResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    const leases = await this.activeCheckpoints()
    if (request.tabId) {
      const existing = findCheckpoint(leases, request.tabId, request.sessionAgentId, request.profileId)
      if (!existing) return failure('attachment-required', 'A pre-existing Chrome tab requires an explicit local lease.', false)
      if (!this.isInstanceReady(existing.extensionInstanceId)) return failure('extension-update-required', 'The selected Chrome profile is updating or reconnecting.', true)
      const tab = checkpointTab(existing, request.tabId, request, '', 'External Chrome tab')
      return { ok: true, result: { tab, created: false, panelRevealRequested: false }, updatedTab: tab }
    }
    const input = request.input as { url?: string; reuseExistingTab: boolean }
    const mapped = leases.find((lease) => lease.sessionAgentId === request.sessionAgentId && lease.profileId === request.profileId)
    if (mapped && !this.isInstanceReady(mapped.extensionInstanceId)) {
      return failure('extension-update-required', 'The selected Chrome profile is updating or reconnecting.', true)
    }
    if (mapped && input.reuseExistingTab && mapped.tabIds[0] !== undefined) {
      return this.openCheckpoint(request, mapped, mapped.tabIds[0], input.url)
    }
    const local = leases.filter((lease) => lease.sessionAgentId === '__local_pending__' && lease.profileId === '__local_pending__' && this.isInstanceReady(lease.extensionInstanceId))
    if (input.reuseExistingTab && local.length === 1 && local[0]!.tabIds[0] !== undefined) {
      const adopted = { ...local[0]!, sessionAgentId: request.sessionAgentId, profileId: request.profileId, expiresAt: this.now() + CHECKPOINT_TTL_MS }
      await this.checkpoints.put(adopted)
      return this.openCheckpoint(request, adopted, adopted.tabIds[0]!, input.url)
    }
    const candidates = mapped ? [mapped.extensionInstanceId] : this.readyConnectionIds()
    const unique = [...new Set(candidates)].filter((id) => this.isInstanceReady(id))
    if (unique.length !== 1) return failure('attachment-required', 'Choose a Chrome profile in the local side panel before creating a tab.', false)
    const extensionInstanceId = unique[0]!
    const leaseId = mapped?.leaseId ?? randomUUID()
    const leaseEpoch = mapped?.leaseEpoch ?? (Math.max(0, ...leases.filter((lease) => lease.extensionInstanceId === extensionInstanceId).map((lease) => lease.leaseEpoch)) + 1)
    const created = await this.connection(extensionInstanceId).request('forge.browser.create', {
      protocolVersion: 1, sessionAgentId: request.sessionAgentId, leaseId, leaseEpoch,
      ...(input.url ? { url: input.url } : {}), groupTitle: `Forge · ${request.sessionAgentId}`.slice(0, 512),
    })
    if (created.extensionInstanceId !== extensionInstanceId || created.sessionAgentId !== request.sessionAgentId ||
      created.leaseId !== leaseId || created.leaseEpoch !== leaseEpoch || created.tab.groupId !== created.groupId) {
      throw new Error('extension create response did not match the authorized compare-and-set scope')
    }
    const checkpoint: ExternalChromeLeaseCheckpoint = {
      extensionInstanceId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, leaseId, leaseEpoch,
      tabIds: [...(mapped?.tabIds ?? []), created.tab.tabId].sort((a, b) => a - b), groupId: created.groupId,
      childPolicy: mapped?.childPolicy ?? 'manual', expiresAt: mapped?.expiresAt ?? (this.now() + CHECKPOINT_TTL_MS),
    }
    await this.checkpoints.put(checkpoint)
    const opaqueTabId = encodeTabId(extensionInstanceId, created.tab.tabId)
    const tab = checkpointTab(checkpoint, opaqueTabId, request, created.tab.url, created.tab.title)
    return { ok: true, result: { tab, created: true, panelRevealRequested: false }, updatedTab: tab }
  }

  private async openCheckpoint(request: BrowserAutomationRequest, checkpoint: ExternalChromeLeaseCheckpoint, tabId: number, url?: string): Promise<ExternalChromeTransportResult> {
    const opaqueTabId = encodeTabId(checkpoint.extensionInstanceId, tabId)
    if (url) {
      const navigated = await this.navigateResult({
        ...request, operation: 'navigate', tabId: opaqueTabId,
        input: { hostKind: 'external-chrome', tabId: opaqueTabId, url, readiness: 'load', timeoutMs: 30_000 },
      } as BrowserAutomationRequest)
      if (!navigated.ok) return navigated
      const tab = navigated.updatedTab!
      return { ok: true, result: { tab, created: false, panelRevealRequested: false }, updatedTab: tab }
    }
    const inspected = await this.statusResult({
      ...request, operation: 'status', tabId: opaqueTabId, input: { hostKind: 'external-chrome', tabId: opaqueTabId },
    } as BrowserAutomationRequest)
    if (!inspected.ok) return inspected
    const selected = (inspected.result as BrowserAutomationResultByOperation['status']).selectedTab
    const tab = selected ?? checkpointTab(checkpoint, opaqueTabId, request, '', 'External Chrome tab')
    return { ok: true, result: { tab, created: false, panelRevealRequested: false }, updatedTab: tab }
  }

  private async navigateResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    if (!request.tabId) return failure('attachment-required', 'Navigation requires an explicitly leased tab.', false)
    const checkpoint = findCheckpoint(await this.activeCheckpoints(), request.tabId, request.sessionAgentId, request.profileId)
    if (!checkpoint) return failure('lease-lost', 'The External Chrome lease is missing or stale.', true)
    const decoded = decodeTabId(request.tabId)
    if (!decoded || decoded.extensionInstanceId !== checkpoint.extensionInstanceId || !checkpoint.tabIds.includes(decoded.tabId)) {
      return failure('lease-lost', 'The tab is outside the authorized lease.', false)
    }
    const rawInput = request.input as Record<string, unknown>
    const { hostKind: _hostKind, tabId: _tabId, ...input } = rawInput
    void _hostKind; void _tabId
    const response = await this.connection(checkpoint.extensionInstanceId).request('forge.browser.execute', {
      protocolVersion: 1, requestId: request.requestId, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
      tabId: decoded.tabId, operation: 'navigate', input: input as { url?: string; environmentPort?: number; environmentProtocol?: 'http' | 'https'; path?: string; readiness: 'load' | 'domContentLoaded' | 'none'; timeoutMs: number }, deadlineAt: request.deadlineAt,
    })
    if (response.requestId !== request.requestId || response.leaseId !== checkpoint.leaseId ||
      response.leaseEpoch !== checkpoint.leaseEpoch || response.tabId !== decoded.tabId || response.operation !== 'navigate') {
      return failure('lease-lost', 'Extension response changed authorized lease routing.', false)
    }
    await this.markCheckpointResumed(checkpoint)
    if (!response.ok) return { ok: false, error: response.error }
    const raw = response.result as BrowserAutomationResultByOperation['navigate']
    const tab = { ...raw.tab, hostKind: 'external-chrome' as const, tabId: request.tabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId }
    return { ok: true, result: { ...raw, tab }, updatedTab: tab }
  }

  private async functionalResult(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    if (!request.tabId) return failure('attachment-required', `${request.operation} requires an explicitly leased tab.`, false)
    const checkpoint = findCheckpoint(await this.activeCheckpoints(), request.tabId, request.sessionAgentId, request.profileId)
    if (!checkpoint) return failure('lease-lost', 'The External Chrome lease is missing or stale.', true)
    const decoded = decodeTabId(request.tabId)
    if (!decoded || decoded.extensionInstanceId !== checkpoint.extensionInstanceId || !checkpoint.tabIds.includes(decoded.tabId)) {
      return failure('lease-lost', 'The tab is outside the authorized lease.', false)
    }
    const rawInput = request.input as Record<string, unknown>
    const { hostKind: _hostKind, tabId: _tabId, ...input } = rawInput
    void _hostKind; void _tabId
    const response = await this.connection(checkpoint.extensionInstanceId).request('forge.browser.execute', {
      protocolVersion: 1, requestId: request.requestId, leaseId: checkpoint.leaseId, leaseEpoch: checkpoint.leaseEpoch,
      tabId: decoded.tabId, operation: request.operation, input, deadlineAt: request.deadlineAt,
    } as ExternalChromeRequestParamsByMethod['forge.browser.execute'])
    if (response.requestId !== request.requestId || response.leaseId !== checkpoint.leaseId || response.leaseEpoch !== checkpoint.leaseEpoch ||
      response.tabId !== decoded.tabId || response.operation !== request.operation) {
      return failure('lease-lost', 'Extension response changed authorized lease routing.', false)
    }
    await this.markCheckpointResumed(checkpoint)
    if (!response.ok) return { ok: false, error: response.error }
    const result = { ...(response.result as unknown as Record<string, unknown>), tabId: request.tabId } as BrowserAutomationResultByOperation[BrowserAutomationOperation]
    return { ok: true, result }
  }

  private async markCheckpointResumed(checkpoint: ExternalChromeLeaseCheckpoint): Promise<void> {
    if (checkpoint.handoffTurnId === undefined) return
    const latest = (await this.checkpoints.all()).find((lease) => lease.extensionInstanceId === checkpoint.extensionInstanceId &&
      lease.leaseId === checkpoint.leaseId && lease.leaseEpoch === checkpoint.leaseEpoch)
    if (latest?.handoffTurnId !== checkpoint.handoffTurnId) return
    const { handoffTurnId: _handoffTurnId, ...resumed } = latest
    void _handoffTurnId
    await this.checkpoints.put(resumed)
  }

  private async activeCheckpoints(): Promise<ExternalChromeLeaseCheckpoint[]> {
    await this.reconcileExpiredLeases()
    return (await this.checkpoints.all()).filter((lease) => lease.releasedAt === undefined && lease.expiresAt > this.now())
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
    const expired = (await this.checkpoints.all()).filter((lease) => lease.releasedAt === undefined && lease.expiresAt <= this.now()
      && (extensionInstanceId === undefined || lease.extensionInstanceId === extensionInstanceId))
    for (const lease of expired) {
      const connection = this.connections.get(lease.extensionInstanceId)
      if (!connection) continue
      try {
        const result = await connection.request('forge.browser.release', {
          protocolVersion: 1, leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch, reason: 'lease-expired',
        })
        if (result.leaseId === lease.leaseId && result.leaseEpoch === lease.leaseEpoch) {
          const current = (await this.checkpoints.all()).find((candidate) => candidate.extensionInstanceId === lease.extensionInstanceId
            && candidate.leaseId === lease.leaseId && candidate.leaseEpoch === lease.leaseEpoch) ?? lease
          if (current.sessionAgentId === '__local_pending__' || current.profileId === '__local_pending__') {
            await this.checkpoints.remove(current.extensionInstanceId, current.leaseId, current.leaseEpoch)
          } else {
            // Merge the latest durable transaction fields: expiry and an explicit
            // lifecycle prepare may race, but neither may erase the other's authority.
            await this.checkpoints.put({ ...current, releasedAt: current.releasedAt ?? this.now() })
          }
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

  private assertAcceptingOperations(): void {
    if (this.operationsQuiesced) throw new Error('extension-update-required')
  }

  private isInstanceReady(extensionInstanceId: string): boolean {
    const state = this.instanceStates.get(extensionInstanceId)
    return state?.recovery === 'ready' && this.connections.get(extensionInstanceId) === state.connection
  }

  private readyConnectionIds(): string[] {
    return [...this.connections.keys()].filter((id) => this.isInstanceReady(id))
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
    if (checkpoints.some((checkpoint) => checkpoint.releasedAt === undefined && !this.connections.has(checkpoint.extensionInstanceId))) return
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
          const firstReport = connection.consumeFirstLeaseReport()
          if (firstReport && existing && (
            canonical(existing.tabIds) !== canonical([...change.tabIds].sort((a, b) => a - b)) ||
            existing.groupId !== change.groupId || existing.childPolicy !== change.childPolicy
          )) {
            throw new Error('reconnect lease proof attempted to expand or change durable scope')
          }
          if (change.state === 'released') {
            if (!existing || existing.sessionAgentId === '__local_pending__' || existing.profileId === '__local_pending__') {
              await this.checkpoints.remove(extensionInstanceId, change.leaseId, change.leaseEpoch)
            } else {
              await this.checkpoints.put({ ...existing, expiresAt: Math.min(existing.expiresAt, this.now()), releasedAt: this.now() })
            }
            return
          }
          if (existing && change.state === 'claimed') {
            const oldTabs = new Set(existing.tabIds)
            const added = change.tabIds.filter((tabId) => !oldTabs.has(tabId))
            if (added.length > 0 && (existing.childPolicy !== 'include-opened-by-leased-tabs' || existing.groupId !== change.groupId)) {
              throw new Error('lease notification attempted unauthorized scope expansion')
            }
          }
          await this.checkpoints.put({
            extensionInstanceId, sessionAgentId: existing?.sessionAgentId ?? '__local_pending__', profileId: existing?.profileId ?? '__local_pending__',
            leaseId: change.leaseId, leaseEpoch: change.leaseEpoch, tabIds: [...change.tabIds].sort((a, b) => a - b),
            groupId: change.groupId, childPolicy: change.childPolicy, expiresAt: this.now() + CHECKPOINT_TTL_MS,
          })
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
              this.scheduleRuntimeUpdateBarrier()
            }
          }
        })
      this.allConnections.add(connection)
    } catch (error) { sessionKey.fill(0); throw error }
  }
}

function encodeTabId(extensionInstanceId: string, tabId: number): string { return `ext.${extensionInstanceId}.${tabId}` }
function decodeTabId(value: string): { extensionInstanceId: string; tabId: number } | null {
  const match = /^ext\.([A-Za-z0-9_-]{1,128})\.([0-9]+)$/u.exec(value)
  if (!match) return null
  const tabId = Number(match[2])
  return Number.isSafeInteger(tabId) ? { extensionInstanceId: match[1]!, tabId } : null
}
function findCheckpoint(leases: ExternalChromeLeaseCheckpoint[], opaqueTabId: string, sessionAgentId: string, profileId: string): ExternalChromeLeaseCheckpoint | undefined {
  const decoded = decodeTabId(opaqueTabId)
  return decoded ? leases.find((lease) => lease.extensionInstanceId === decoded.extensionInstanceId && lease.tabIds.includes(decoded.tabId) && lease.sessionAgentId === sessionAgentId && lease.profileId === profileId) : undefined
}
function checkpointTab(_checkpoint: ExternalChromeLeaseCheckpoint, opaqueTabId: string, request: BrowserAutomationRequest, url: string, title: string): BrowserTabSnapshot {
  const now = new Date().toISOString()
  return {
    hostKind: 'external-chrome', tabId: opaqueTabId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url, title, lifecycle: 'ready', loading: false, live: true, canGoBack: false, canGoForward: false,
    zoomFactor: 1, controller: 'human', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' },
    renderedViewport: null, physicalVisible: false, error: null, createdAt: now, updatedAt: now,
  }
}
function failure(code: BrowserAutomationFailure['code'], message: string, retryable: boolean): ExternalChromeTransportResult {
  return { ok: false, error: { code, message, retryable } }
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
