import {
  EXTERNAL_CHROME_PHYSICAL_DEBUGGER_IDLE_TIMEOUT_MS,
  EXTERNAL_CHROME_PHYSICAL_DEBUGGER_MAXIMUM_LIFETIME_MS,
} from '@forge/protocol'
import {
  DebuggerAttachConflictError,
  DebuggerAttachmentLimitError,
  DebuggerController,
  DebuggerIdentityLossError,
  type DebuggerState,
} from './debugger-controller.js'

export const DEFAULT_DEBUGGER_IDLE_TIMEOUT_MS = EXTERNAL_CHROME_PHYSICAL_DEBUGGER_IDLE_TIMEOUT_MS
export const DEFAULT_DEBUGGER_MAXIMUM_LIFETIME_MS = EXTERNAL_CHROME_PHYSICAL_DEBUGGER_MAXIMUM_LIFETIME_MS
const MAX_DETACH_REASON_METRICS = 64

export type PhysicalDebuggerDetachReason =
  | 'trusted-input'
  | 'external-navigation'
  | 'devtools-preemption'
  | 'debugger-detached'
  | 'transport-uncertain'
  | 'idle-timeout'
  | 'maximum-lifetime'
  | 'restricted-target'
  | 'identity-loss'
  | 'operation-cancelled'
  | 'operation-failed'
  | 'tab-closed'
  | 'runtime-update'
  | 'runtime-shutdown'
  | 'lease-expired'
  | `release:${string}`

export interface PhysicalDebuggerSessionSnapshot {
  tabId: number
  leaseId: string
  leaseEpoch: number
  debuggerState: DebuggerState
  attachedAt: number
  lastUsedAt: number
  operationActive: boolean
}

export interface PhysicalDebuggerMetricsSnapshot {
  attachAttempts: number
  attachments: number
  attachmentReuses: number
  attachConflicts: number
  attachmentLimitRejections: number
  attachFailures: number
  detachments: number
  preemptions: number
  activeAttachments: number
  maximumObservedAttachments: number
  totalAttachedMs: number
  maximumAttachedMs: number
  detachReasons: Record<string, number>
}

interface PhysicalDebuggerSession {
  tabId: number
  leaseId: string
  leaseEpoch: number
  attachedAt: number
  lastUsedAt: number
  operationActive: boolean
  idleTimer: unknown | null
  lifetimeTimer: unknown | null
}

export interface ControlSessionScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ControlSessionManagerOptions {
  now?: () => number
  scheduler?: ControlSessionScheduler
  idleTimeoutMs?: number
  maximumLifetimeMs?: number
  onExpiry: (tabId: number, reason: 'idle-timeout' | 'maximum-lifetime') => void | Promise<void>
}

const defaultScheduler: ControlSessionScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Owns only physical debugger lifetime. Lease/CAS authority remains in LeaseManager, which keeps
 * operation-idle authority and Chrome attachment state independently observable and enforceable.
 */
export class ControlSessionManager {
  private readonly sessions = new Map<number, PhysicalDebuggerSession>()
  private readonly detachTasks = new Map<number, Promise<void>>()
  private readonly now: () => number
  private readonly scheduler: ControlSessionScheduler
  private readonly idleTimeoutMs: number
  private readonly maximumLifetimeMs: number
  private attachAttempts = 0
  private attachments = 0
  private attachmentReuses = 0
  private attachConflicts = 0
  private attachmentLimitRejections = 0
  private attachFailures = 0
  private detachments = 0
  private preemptions = 0
  private maximumObservedAttachments = 0
  private totalAttachedMs = 0
  private maximumAttachedMs = 0
  private readonly detachReasons = new Map<string, number>()

  constructor(
    private readonly debuggers: DebuggerController,
    private readonly options: ControlSessionManagerOptions,
  ) {
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler ?? defaultScheduler
    this.idleTimeoutMs = boundedDuration(options.idleTimeoutMs, DEFAULT_DEBUGGER_IDLE_TIMEOUT_MS)
    this.maximumLifetimeMs = boundedDuration(options.maximumLifetimeMs, DEFAULT_DEBUGGER_MAXIMUM_LIFETIME_MS)
    if (this.maximumLifetimeMs < this.idleTimeoutMs) throw new Error('debugger maximum lifetime must cover its idle timeout')
  }

  async ensure(tabId: number, leaseId: string, leaseEpoch: number): Promise<'attached' | 'reused'> {
    if (this.detachTasks.has(tabId)) throw new DebuggerIdentityLossError('terminal debugger detach is still pending')
    const existing = this.sessions.get(tabId)
    if (existing !== undefined) {
      if (existing.leaseId !== leaseId || existing.leaseEpoch !== leaseEpoch) {
        throw new Error('physical debugger session belongs to another exact lease')
      }
      if (this.debuggers.state(tabId) !== 'ATTACHED') throw new Error('physical debugger attachment was lost')
      // Claim the reusable session synchronously before identity revalidation yields, otherwise an
      // already-queued idle callback could detach underneath the next operation's proof.
      this.clearIdle(existing)
      existing.lastUsedAt = this.now()
      await this.debuggers.revalidateRoot(tabId)
      this.attachmentReuses += 1
      return 'reused'
    }
    if (this.debuggers.state(tabId) !== 'UNATTACHED') throw new Error(`unowned debugger state is ${this.debuggers.state(tabId)}`)

    this.attachAttempts += 1
    try {
      await this.debuggers.attach(tabId)
    } catch (error) {
      if (error instanceof DebuggerAttachConflictError) this.attachConflicts += 1
      else if (error instanceof DebuggerAttachmentLimitError) this.attachmentLimitRejections += 1
      else this.attachFailures += 1
      throw error
    }
    if (this.debuggers.state(tabId) !== 'ATTACHED' || this.detachTasks.has(tabId)) {
      throw new DebuggerIdentityLossError('debugger attachment was released before the control session could adopt it')
    }
    const attachedAt = this.now()
    const session: PhysicalDebuggerSession = {
      tabId,
      leaseId,
      leaseEpoch,
      attachedAt,
      lastUsedAt: attachedAt,
      operationActive: false,
      idleTimer: null,
      lifetimeTimer: null,
    }
    session.lifetimeTimer = this.scheduler.setTimeout(() => {
      session.lifetimeTimer = null
      if (this.sessions.get(tabId) === session) this.runExpiry(tabId, 'maximum-lifetime')
    }, this.maximumLifetimeMs)
    this.sessions.set(tabId, session)
    this.attachments += 1
    this.maximumObservedAttachments = Math.max(this.maximumObservedAttachments, this.sessions.size)
    return 'attached'
  }

  beginOperation(tabId: number, leaseId: string, leaseEpoch: number): void {
    const session = this.assertExact(tabId, leaseId, leaseEpoch)
    this.clearIdle(session)
    session.operationActive = true
    session.lastUsedAt = this.now()
  }

  finishOperation(tabId: number, leaseId: string, leaseEpoch: number): void {
    const session = this.sessions.get(tabId)
    if (session === undefined || session.leaseId !== leaseId || session.leaseEpoch !== leaseEpoch) return
    session.operationActive = false
    this.scheduleIdle(session)
  }

  /** Refreshes an exact attached-idle session while navigation identity is being re-proved. */
  refreshIdle(tabId: number, leaseId: string, leaseEpoch: number): void {
    const session = this.assertExact(tabId, leaseId, leaseEpoch)
    if (session.operationActive) throw new Error('physical debugger operation is active')
    this.scheduleIdle(session)
  }

  detach(tabId: number, reason: PhysicalDebuggerDetachReason): Promise<void> {
    const existingTask = this.detachTasks.get(tabId)
    if (existingTask !== undefined) return existingTask
    const session = this.sessions.get(tabId)
    if (session !== undefined) this.clearTimers(session)
    const task = this.debuggers.reset(tabId).then(() => {
      if (session !== undefined && this.sessions.get(tabId) === session) this.forgetSession(session, reason)
    })
    this.detachTasks.set(tabId, task)
    return task.finally(() => {
      if (this.detachTasks.get(tabId) === task) this.detachTasks.delete(tabId)
    })
  }

  acknowledgeExternalDetach(tabId: number, reason: PhysicalDebuggerDetachReason, preempted = false): void {
    this.debuggers.acknowledgeExternalDetach(tabId)
    const session = this.sessions.get(tabId)
    if (session === undefined) return
    this.clearTimers(session)
    if (preempted) this.preemptions += 1
    this.forgetSession(session, reason)
  }

  acknowledgeTargetClosed(tabId: number): void {
    this.debuggers.acknowledgeTargetClosed(tabId)
    this.acknowledgeExternalDetach(tabId, 'tab-closed')
  }

  isAttachedFor(tabId: number, leaseId: string, leaseEpoch: number): boolean {
    const session = this.sessions.get(tabId)
    return session?.leaseId === leaseId && session.leaseEpoch === leaseEpoch && this.debuggers.state(tabId) === 'ATTACHED'
  }

  forTab(tabId: number): PhysicalDebuggerSessionSnapshot | null {
    const session = this.sessions.get(tabId)
    return session === undefined ? null : this.snapshotSession(session)
  }

  all(): PhysicalDebuggerSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => this.snapshotSession(session)).sort((left, right) => left.tabId - right.tabId)
  }

  metrics(): PhysicalDebuggerMetricsSnapshot {
    const now = this.now()
    const activeDuration = [...this.sessions.values()].reduce((total, session) => total + Math.max(0, now - session.attachedAt), 0)
    return {
      attachAttempts: this.attachAttempts,
      attachments: this.attachments,
      attachmentReuses: this.attachmentReuses,
      attachConflicts: this.attachConflicts,
      attachmentLimitRejections: this.attachmentLimitRejections,
      attachFailures: this.attachFailures,
      detachments: this.detachments,
      preemptions: this.preemptions,
      activeAttachments: this.sessions.size,
      maximumObservedAttachments: this.maximumObservedAttachments,
      totalAttachedMs: this.totalAttachedMs + activeDuration,
      maximumAttachedMs: Math.max(this.maximumAttachedMs, ...[...this.sessions.values()].map((session) => Math.max(0, now - session.attachedAt)), 0),
      detachReasons: Object.fromEntries([...this.detachReasons].sort(([left], [right]) => left.localeCompare(right))),
    }
  }

  private runExpiry(tabId: number, reason: 'idle-timeout' | 'maximum-lifetime'): void {
    try {
      void Promise.resolve(this.options.onExpiry(tabId, reason)).catch(() => undefined)
    } catch { /* Runtime retains exact authority for its next cleanup retry. */ }
  }

  private assertExact(tabId: number, leaseId: string, leaseEpoch: number): PhysicalDebuggerSession {
    const session = this.sessions.get(tabId)
    if (session === undefined || session.leaseId !== leaseId || session.leaseEpoch !== leaseEpoch || this.debuggers.state(tabId) !== 'ATTACHED') {
      throw new Error('exact physical debugger session is unavailable')
    }
    return session
  }

  private snapshotSession(session: PhysicalDebuggerSession): PhysicalDebuggerSessionSnapshot {
    return {
      tabId: session.tabId,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
      debuggerState: this.debuggers.state(session.tabId),
      attachedAt: session.attachedAt,
      lastUsedAt: session.lastUsedAt,
      operationActive: session.operationActive,
    }
  }

  private forgetSession(session: PhysicalDebuggerSession, reason: PhysicalDebuggerDetachReason): void {
    if (this.sessions.get(session.tabId) !== session) return
    this.sessions.delete(session.tabId)
    const duration = Math.max(0, this.now() - session.attachedAt)
    this.totalAttachedMs += duration
    this.maximumAttachedMs = Math.max(this.maximumAttachedMs, duration)
    this.detachments += 1
    const metricReason = this.detachReasons.has(reason) || this.detachReasons.size < MAX_DETACH_REASON_METRICS ? reason : 'other'
    this.detachReasons.set(metricReason, (this.detachReasons.get(metricReason) ?? 0) + 1)
  }

  private scheduleIdle(session: PhysicalDebuggerSession): void {
    session.lastUsedAt = this.now()
    this.clearIdle(session)
    session.idleTimer = this.scheduler.setTimeout(() => {
      session.idleTimer = null
      if (this.sessions.get(session.tabId) === session && !session.operationActive) {
        this.runExpiry(session.tabId, 'idle-timeout')
      }
    }, this.idleTimeoutMs)
  }

  private clearIdle(session: PhysicalDebuggerSession): void {
    if (session.idleTimer === null) return
    this.scheduler.clearTimeout(session.idleTimer)
    session.idleTimer = null
  }

  private clearTimers(session: PhysicalDebuggerSession): void {
    this.clearIdle(session)
    if (session.lifetimeTimer === null) return
    this.scheduler.clearTimeout(session.lifetimeTimer)
    session.lifetimeTimer = null
  }
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 1 && value! <= 15 * 60_000 ? value! : fallback
}
