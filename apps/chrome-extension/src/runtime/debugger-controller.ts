import type { ChromeDebuggerApi, ChromeDebuggerSession, ChromeDebuggerTarget } from './chrome-api.js'

export type DebuggerState = 'UNATTACHED' | 'ATTACHING' | 'ATTACHED' | 'DETACHING' | 'LOST'

export const DEFAULT_MAX_SIMULTANEOUS_DEBUGGER_ATTACHMENTS = 8

interface TargetNode {
  targetId: string
  sessionId?: string
  parentTargetId: string | null
  frameId?: string
}

interface AttachedTargetParams {
  sessionId?: unknown
  targetInfo?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export class OopifAncestryTracker {
  private readonly nodes = new Map<string, TargetNode>()
  private readonly targetBySession = new Map<string, string>()
  private readonly parentByFrame = new Map<string, string | null>()
  private rootTargetId: string | null = null

  registerRoot(targetId: string, rootFrameId?: string): void {
    this.clear()
    this.rootTargetId = targetId
    this.nodes.set(targetId, { targetId, parentTargetId: null, ...(rootFrameId === undefined ? {} : { frameId: rootFrameId }) })
    if (rootFrameId !== undefined) this.parentByFrame.set(rootFrameId, null)
  }

  attached(sourceSessionId: string | undefined, rawParams: AttachedTargetParams): { accepted: boolean; sessionId?: string; targetId?: string } {
    if (this.rootTargetId === null) return { accepted: false }
    const targetInfo = record(rawParams.targetInfo)
    const sessionId = typeof rawParams.sessionId === 'string' ? rawParams.sessionId : undefined
    const targetId = typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : undefined
    const type = typeof targetInfo?.type === 'string' ? targetInfo.type : ''
    if (sessionId === undefined || targetId === undefined || type !== 'iframe') return { accepted: false, ...(sessionId === undefined ? {} : { sessionId }), ...(targetId === undefined ? {} : { targetId }) }
    // Target IDs become accepted only after the Page frame tree proves exact ancestry.
    if (!this.parentByFrame.has(targetId)) return { accepted: false, sessionId, targetId }
    const expectedParentFrameId = this.parentByFrame.get(targetId)
    const expectedParent = [...this.nodes.values()].find((node) => node.frameId === expectedParentFrameId)
    const parentTargetId = sourceSessionId === undefined ? this.rootTargetId : this.targetBySession.get(sourceSessionId)
    if (expectedParent === undefined || parentTargetId !== expectedParent.targetId || !this.isDescendantOrRoot(parentTargetId)) {
      return { accepted: false, sessionId, targetId }
    }
    this.nodes.set(targetId, { targetId, sessionId, parentTargetId, frameId: targetId })
    this.targetBySession.set(sessionId, targetId)
    return { accepted: true, sessionId, targetId }
  }

  frameAttached(frameId: string, parentFrameId: string | null): boolean {
    if (this.rootTargetId === null || frameId.length === 0 || parentFrameId === null) return false
    if (!this.frameBelongsToKnownAncestry(parentFrameId)) return false
    this.parentByFrame.set(frameId, parentFrameId)
    return true
  }

  validatesTargetInfo(sessionId: string, value: unknown): boolean {
    const targetInfo = record(value)
    const targetId = this.targetBySession.get(sessionId)
    return targetId !== undefined && targetInfo?.targetId === targetId &&
      (targetInfo.type === 'iframe' || targetInfo.type === 'page') && targetInfo.attached !== false &&
      this.isDescendantOrRoot(targetId)
  }

  detached(sessionId: string): void {
    const targetId = this.targetBySession.get(sessionId)
    if (targetId === undefined) return
    const descendants = [...this.nodes.values()]
      .filter((node) => node.targetId === targetId || this.hasTargetAncestor(node.targetId, targetId))
      .map((node) => node.targetId)
    for (const descendant of descendants) {
      const node = this.nodes.get(descendant)
      if (node?.sessionId !== undefined) this.targetBySession.delete(node.sessionId)
      this.nodes.delete(descendant)
    }
  }

  acceptsSession(sessionId: string): boolean {
    const targetId = this.targetBySession.get(sessionId)
    return targetId !== undefined && this.isDescendantOrRoot(targetId)
  }

  targetIdForSession(sessionId: string): string | undefined {
    return this.targetBySession.get(sessionId)
  }

  sessions(): Array<{ sessionId: string; targetId: string }> {
    return [...this.targetBySession.entries()]
      .filter(([, targetId]) => this.isDescendantOrRoot(targetId))
      .map(([sessionId, targetId]) => ({ sessionId, targetId }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  /** Child-to-root route chain. Every edge was proven by the frame tree and flat Target session. */
  routeChain(targetId: string): Array<{ targetId: string; sessionId?: string; parentTargetId: string | null; frameId?: string }> {
    if (!this.isDescendantOrRoot(targetId)) return []
    return this.ancestry(targetId).flatMap((id) => {
      const node = this.nodes.get(id)
      return node === undefined ? [] : [{ ...node }]
    })
  }

  rootId(): string | null {
    return this.rootTargetId
  }

  ancestry(targetId: string): string[] {
    const result: string[] = []
    let current: string | null | undefined = targetId
    const visited = new Set<string>()
    while (current !== null && current !== undefined && !visited.has(current)) {
      visited.add(current)
      result.push(current)
      current = this.nodes.get(current)?.parentTargetId
    }
    return result
  }

  clear(): void {
    this.nodes.clear()
    this.targetBySession.clear()
    this.parentByFrame.clear()
    this.rootTargetId = null
  }

  private isDescendantOrRoot(targetId: string): boolean {
    return this.rootTargetId !== null && this.ancestry(targetId).includes(this.rootTargetId)
  }

  private hasTargetAncestor(targetId: string, ancestor: string): boolean {
    return this.ancestry(targetId).slice(1).includes(ancestor)
  }

  private frameBelongsToKnownAncestry(frameId: string): boolean {
    if ([...this.nodes.values()].some((node) => node.frameId === frameId)) return true
    const visited = new Set<string>()
    let current: string | null | undefined = frameId
    while (current !== null && current !== undefined && !visited.has(current)) {
      visited.add(current)
      if ([...this.nodes.values()].some((node) => node.frameId === current)) return true
      current = this.parentByFrame.get(current)
    }
    return false
  }
}

function seedFrameTree(tracker: OopifAncestryTracker, value: unknown, parentFrameId: string | null = null): void {
  const tree = record(value)
  const frame = record(tree?.frame)
  const frameId = typeof frame?.id === 'string' ? frame.id : undefined
  if (frameId === undefined) return
  if (parentFrameId !== null) tracker.frameAttached(frameId, parentFrameId)
  if (!Array.isArray(tree?.childFrames)) return
  for (const child of tree.childFrames) seedFrameTree(tracker, child, frameId)
}

export interface DebuggerDetachNotice {
  tabId: number
  reason: string
  expected: boolean
  devtoolsContention: boolean
}

/** Raised only when Chrome's initial debugger attach reports its exact ownership conflict. */
export class DebuggerAttachConflictError extends Error {
  constructor(message: string) {
    super(message.slice(0, 1_024))
    this.name = 'DebuggerAttachConflictError'
  }
}

export class DebuggerAttachmentLimitError extends Error {
  constructor(readonly maximum: number) {
    super(`External Chrome debugger attachment bound (${maximum}) is full`)
    this.name = 'DebuggerAttachmentLimitError'
  }
}

export class DebuggerIdentityLossError extends Error {
  constructor(message = 'Chrome could not prove the leased root debugger identity') {
    super(message)
    this.name = 'DebuggerIdentityLossError'
  }
}

function isDebuggerAttachConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /^Another debugger is already attached(?: to the tab with id: [0-9]+)?\.?$/u.test(message)
}

export interface DebuggerRoute {
  targetId: string
  sessionId?: string
}

export class DebuggerController {
  private readonly states = new Map<number, DebuggerState>()
  private readonly trackers = new Map<number, OopifAncestryTracker>()
  private readonly navigationSignals = new Map<number, Set<(method: string) => void>>()
  private readonly navigationGenerations = new Map<number, number>()
  private readonly pendingCommands = new Map<number, Set<Promise<unknown>>>()
  private readonly attachTasks = new Map<number, Promise<void>>()
  private readonly closedDuringAttach = new Set<number>()
  private readonly resetTasks = new Map<number, Promise<void>>()

  constructor(
    private readonly debuggerApi: ChromeDebuggerApi,
    private readonly maximumAttachments = DEFAULT_MAX_SIMULTANEOUS_DEBUGGER_ATTACHMENTS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maximumAttachments) || maximumAttachments < 1 || maximumAttachments > 32) {
      throw new Error('debugger attachment bound is invalid')
    }
  }

  state(tabId: number): DebuggerState {
    return this.states.get(tabId) ?? 'UNATTACHED'
  }

  tracker(tabId: number): OopifAncestryTracker | undefined {
    return this.trackers.get(tabId)
  }

  async reconcileForRelease(tabId: number, _extensionId: string): Promise<'none' | 'owned' | 'foreign'> {
    const target = (await this.debuggerApi.getTargets()).find((candidate) => candidate.tabId === tabId && candidate.attached === true)
    this.trackers.delete(tabId)
    if (target === undefined) {
      this.states.delete(tabId)
      this.navigationGenerations.delete(tabId)
      return 'none'
    }
    try {
      // TargetInfo.extensionId identifies an extension *target*, not the debugger owner. A benign
      // command over our tab-scoped channel is the positive proof that this extension owns the
      // recovered attachment; it is adopted only long enough for immediate exact detach.
      const response = record(await this.debuggerApi.sendCommand({ tabId }, 'Target.getTargetInfo'))
      const info = record(response?.targetInfo)
      const targetId = typeof info?.targetId === 'string' ? info.targetId : undefined
      if (targetId === undefined || info?.type !== 'page' || info.attached === false ||
        target.targetId !== undefined && target.targetId !== targetId) {
        throw new DebuggerIdentityLossError('Chrome could not prove the recovered debugger target')
      }
      this.states.set(tabId, 'ATTACHED')
      return 'owned'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/debugger is not attached|not attached to the tab|no debugger (?:is )?attached/iu.test(message)) {
        // Chrome proves another debugger owns the advertised attachment. Never detach it.
        this.states.delete(tabId)
        this.navigationGenerations.delete(tabId)
        return 'foreign'
      }
      this.states.set(tabId, 'LOST')
      throw error
    }
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachTasks.has(tabId) || this.state(tabId) !== 'UNATTACHED') throw new Error(`debugger is ${this.state(tabId)}`)
    this.closedDuringAttach.delete(tabId)
    const task = this.attachNow(tabId)
    this.attachTasks.set(tabId, task)
    try {
      await task
    } finally {
      if (this.attachTasks.get(tabId) === task) this.attachTasks.delete(tabId)
    }
  }

  private async attachNow(tabId: number): Promise<void> {
    if (this.state(tabId) !== 'UNATTACHED') throw new Error(`debugger is ${this.state(tabId)}`)
    const occupied = [...this.states.values()].filter((state) => state !== 'UNATTACHED').length
    if (occupied >= this.maximumAttachments) throw new DebuggerAttachmentLimitError(this.maximumAttachments)
    this.states.set(tabId, 'ATTACHING')
    const target: ChromeDebuggerTarget = { tabId }
    let didAttach = false
    try {
      try {
        await this.debuggerApi.attach(target, '1.3')
      } catch (error) {
        if (isDebuggerAttachConflict(error)) {
          throw new DebuggerAttachConflictError(error instanceof Error ? error.message : String(error))
        }
        throw error
      }
      didAttach = true
      this.assertAttachContinuing(tabId)
      const tracker = new OopifAncestryTracker()
      await this.debuggerApi.sendCommand(target, 'Page.enable')
      this.assertAttachContinuing(tabId)
      const targetInfoResult = record(await this.debuggerApi.sendCommand(target, 'Target.getTargetInfo'))
      this.assertAttachContinuing(tabId)
      const targetInfo = record(targetInfoResult?.targetInfo)
      const rootTargetId = typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : undefined
      if (rootTargetId === undefined || targetInfo?.type !== 'page' || targetInfo.attached === false) {
        throw new Error('Chrome did not prove the root target identity')
      }
      const frameTreeResult = record(await this.debuggerApi.sendCommand(target, 'Page.getFrameTree'))
      this.assertAttachContinuing(tabId)
      const frameTree = record(frameTreeResult?.frameTree)
      const rootFrame = record(frameTree?.frame)
      const rootFrameId = typeof rootFrame?.id === 'string' ? rootFrame.id : undefined
      if (frameTree === null || rootFrameId === undefined) throw new Error('Chrome did not prove the root frame identity')
      tracker.registerRoot(rootTargetId, rootFrameId)
      seedFrameTree(tracker, frameTree)
      this.trackers.set(tabId, tracker)
      this.navigationGenerations.set(tabId, this.navigationGenerations.get(tabId) ?? 0)
      await this.debuggerApi.sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      this.assertAttachContinuing(tabId)
      this.states.set(tabId, 'ATTACHED')
    } catch (error) {
      this.trackers.delete(tabId)
      this.navigationGenerations.delete(tabId)
      const targetClosed = this.closedDuringAttach.delete(tabId)
      if (targetClosed) {
        this.states.delete(tabId)
        throw error
      }
      if (!didAttach) {
        this.states.delete(tabId)
        throw error
      }
      this.states.set(tabId, 'DETACHING')
      try {
        await this.debuggerApi.detach(target)
        this.states.delete(tabId)
      } catch (detachError) {
        if (this.state(tabId) !== 'UNATTACHED') {
          // Partial setup still acquired the physical debugger. Never advertise it as unattached
          // until Chrome acknowledges a later exact detach retry.
          this.states.set(tabId, 'LOST')
          throw new Error('partial debugger attachment could not be safely detached', { cause: detachError })
        }
      }
      throw error
    }
  }

  /**
   * Re-proves the root over the tab-scoped debugger channel. A renderer/process swap may change
   * target ID without changing exact tab authority; only this positive proof may adopt it.
   */
  async revalidateRoot(tabId: number): Promise<{ changed: boolean; targetId: string }> {
    try {
      if (this.state(tabId) !== 'ATTACHED') throw new DebuggerIdentityLossError('debugger target is not attached')
      const targetInfoResult = record(await this.sendCommand(tabId, 'Target.getTargetInfo'))
      const targetInfo = record(targetInfoResult?.targetInfo)
      const targetId = typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : undefined
      if (targetId === undefined || targetInfo?.type !== 'page' || targetInfo.attached === false) {
        throw new DebuggerIdentityLossError()
      }
      const current = this.trackers.get(tabId)?.rootId()
      if (current === targetId) return { changed: false, targetId }

      const frameTreeResult = record(await this.sendCommand(tabId, 'Page.getFrameTree'))
      const frameTree = record(frameTreeResult?.frameTree)
      const rootFrame = record(frameTree?.frame)
      const rootFrameId = typeof rootFrame?.id === 'string' ? rootFrame.id : undefined
      if (frameTree === null || rootFrameId === undefined) throw new DebuggerIdentityLossError('Chrome could not prove the replacement root frame')
      const tracker = new OopifAncestryTracker()
      tracker.registerRoot(targetId, rootFrameId)
      seedFrameTree(tracker, frameTree)
      this.trackers.set(tabId, tracker)
      this.navigationGenerations.set(tabId, this.navigationGeneration(tabId) + 1)
      await this.sendCommand(tabId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      return { changed: true, targetId }
    } catch (error) {
      if (error instanceof DebuggerIdentityLossError) throw error
      throw new DebuggerIdentityLossError(error instanceof Error ? error.message : 'Chrome root identity revalidation failed')
    }
  }

  async sendCommand(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.state(tabId) !== 'ATTACHED') throw new Error('debugger target is not attached')
    if (sessionId !== undefined && this.trackers.get(tabId)?.acceptsSession(sessionId) !== true) {
      throw new Error('debugger child session is outside the proven leased-root ancestry')
    }
    return this.trackCommand(tabId, this.debuggerApi.sendCommand({ tabId, ...(sessionId === undefined ? {} : { sessionId }) }, method, params))
  }

  routes(tabId: number): DebuggerRoute[] {
    const tracker = this.trackers.get(tabId)
    const root = tracker?.rootId()
    if (this.state(tabId) !== 'ATTACHED' || tracker === undefined || root === null || root === undefined) return []
    return [
      { targetId: root },
      ...tracker.sessions().map(({ targetId, sessionId }) => ({ targetId, sessionId })),
    ]
  }

  navigationGeneration(tabId: number): number {
    return this.navigationGenerations.get(tabId) ?? 0
  }

  routeChain(tabId: number, route: DebuggerRoute): DebuggerRoute[] {
    const tracker = this.trackers.get(tabId)
    if (this.state(tabId) !== 'ATTACHED' || tracker === undefined) return []
    return tracker.routeChain(route.targetId).map(({ targetId, sessionId }) => ({ targetId, ...(sessionId === undefined ? {} : { sessionId }) }))
  }

  /**
   * Settle the commands that were in flight at a collaborative-input collision without detaching
   * an otherwise proven exact debugger session. The invalidated control epoch prevents their
   * results from being observed, and the per-tab operation queue cannot advance until this proof
   * completes.
   */
  async settlePending(tabId: number, deadlineAt: number): Promise<void> {
    const pending = [...(this.pendingCommands.get(tabId) ?? [])]
    if (pending.length === 0) return
    const remaining = Math.max(0, deadlineAt - this.now())
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('collaborative command settlement exceeded the operation deadline')), remaining)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * Fail-closed cancellation primitive. Chrome settles outstanding debugger commands when the
   * owning debugger detaches; waiting for those settlements prevents a stale command from
   * escaping the tab queue. Callers must revoke the lease before invoking this method.
   */
  async reset(tabId: number): Promise<void> {
    const existing = this.resetTasks.get(tabId)
    if (existing !== undefined) return existing
    const reset = this.resetNow(tabId)
    this.resetTasks.set(tabId, reset)
    try {
      await reset
    } finally {
      if (this.resetTasks.get(tabId) === reset) this.resetTasks.delete(tabId)
    }
  }

  async navigateAndWait(
    tabId: number,
    url: string,
    readiness: 'load' | 'domContentLoaded' | 'none',
    deadlineAt: number,
    isAuthorized: () => boolean,
    onDispatch?: () => void,
  ): Promise<void> {
    if (this.state(tabId) !== 'ATTACHED') throw new Error('debugger target is not attached')
    if (!isAuthorized()) throw new Error('lease authority was interrupted')
    const dispatch = (): Promise<unknown> => {
      // Attachment setup and content-script preflight happen before this method. Re-check both
      // caller bounds in the same synchronous turn as the sole mutation dispatch.
      if (deadlineAt <= this.now()) throw new Error(`navigation readiness ${readiness} timed out`)
      if (!isAuthorized()) throw new Error('lease authority was interrupted')
      onDispatch?.()
      return this.trackCommand(tabId, this.debuggerApi.sendCommand({ tabId }, 'Page.navigate', { url }))
    }
    if (readiness === 'none') {
      await dispatch()
      if (!isAuthorized()) throw new Error('lease authority was interrupted')
      return
    }
    const expected = readiness === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired'
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let commandSettled = false
      let milestoneReached = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearInterval(authorityTimer)
        clearTimeout(deadlineTimer)
        const signals = this.navigationSignals.get(tabId)
        signals?.delete(onSignal)
        if (signals?.size === 0) this.navigationSignals.delete(tabId)
        if (error) reject(error)
        else resolve()
      }
      const finishIfComplete = (): void => {
        if (!commandSettled || !milestoneReached) return
        finish(isAuthorized() ? undefined : new Error('lease authority was interrupted'))
      }
      const onSignal = (method: string): void => {
        if (method === expected) {
          milestoneReached = true
          finishIfComplete()
        } else if (method === 'Debugger.detached') finish(new Error('debugger detached during navigation'))
      }
      const signals = this.navigationSignals.get(tabId) ?? new Set<(method: string) => void>()
      signals.add(onSignal)
      this.navigationSignals.set(tabId, signals)
      const remaining = Math.max(0, deadlineAt - this.now())
      const deadlineTimer = setTimeout(() => finish(new Error(`navigation readiness ${readiness} timed out`)), remaining)
      const authorityTimer = setInterval(() => { if (!isAuthorized()) finish(new Error('lease authority was interrupted')) }, Math.min(25, Math.max(1, remaining)))
      try {
        void dispatch().then(() => {
          commandSettled = true
          finishIfComplete()
        }, (error) => finish(error instanceof Error ? error : new Error(String(error))))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async sendInput(tabId: number, method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText' | 'Input.dispatchTouchEvent', params: Record<string, unknown>): Promise<unknown> {
    if (this.state(tabId) !== 'ATTACHED') throw new Error('debugger input target is not attached')
    return this.trackCommand(tabId, this.debuggerApi.sendCommand({ tabId }, method, params))
  }

  /** An onDetach event is Chrome's physical acknowledgement; LOST only gates handling until Runtime records it. */
  acknowledgeExternalDetach(tabId: number): void {
    if (this.state(tabId) !== 'LOST' && this.state(tabId) !== 'DETACHING') return
    this.states.delete(tabId)
    this.trackers.delete(tabId)
    this.navigationGenerations.delete(tabId)
  }

  /** Target destruction itself acknowledges physical debugger loss. */
  acknowledgeTargetClosed(tabId: number): void {
    if (this.attachTasks.has(tabId) || this.state(tabId) === 'ATTACHING') this.closedDuringAttach.add(tabId)
    for (const signal of this.navigationSignals.get(tabId) ?? []) signal('Debugger.detached')
    this.navigationSignals.delete(tabId)
    this.states.delete(tabId)
    this.trackers.delete(tabId)
    this.navigationGenerations.delete(tabId)
  }

  async detach(tabId: number): Promise<void> {
    const state = this.state(tabId)
    if (state === 'UNATTACHED') return
    this.states.set(tabId, 'DETACHING')
    try {
      await this.debuggerApi.detach({ tabId })
    } catch (error) {
      // onDetach may positively acknowledge release before the API promise rejects. Only restore
      // ownership when no such physical acknowledgement reached us.
      if (this.state(tabId) !== 'UNATTACHED') {
        this.states.set(tabId, state)
        throw error
      }
    }
    this.states.delete(tabId)
    this.trackers.delete(tabId)
    this.navigationGenerations.delete(tabId)
  }

  private assertAttachContinuing(tabId: number): void {
    if (this.state(tabId) !== 'ATTACHING' || this.closedDuringAttach.has(tabId)) {
      throw new Error('debugger attachment was cancelled before setup completed')
    }
  }

  private async resetNow(tabId: number): Promise<void> {
    await this.attachTasks.get(tabId)?.catch(() => undefined)
    const pending = [...(this.pendingCommands.get(tabId) ?? [])]
    await this.detach(tabId)
    await Promise.allSettled(pending)
  }

  private trackCommand(tabId: number, command: Promise<unknown>): Promise<unknown> {
    const pending = this.pendingCommands.get(tabId) ?? new Set<Promise<unknown>>()
    pending.add(command)
    this.pendingCommands.set(tabId, pending)
    void command.then(() => this.forgetCommand(tabId, command), () => this.forgetCommand(tabId, command))
    return command
  }

  private forgetCommand(tabId: number, command: Promise<unknown>): void {
    const pending = this.pendingCommands.get(tabId)
    pending?.delete(command)
    if (pending?.size === 0) this.pendingCommands.delete(tabId)
  }

  async detachAll(): Promise<void> {
    await Promise.allSettled([...this.states.keys()].map((tabId) => this.detach(tabId)))
  }

  targetId(tabId: number, sessionId?: string): string | undefined {
    const tracker = this.trackers.get(tabId)
    return sessionId === undefined ? tracker?.rootId() ?? undefined : tracker?.targetIdForSession(sessionId)
  }

  async onEvent(source: ChromeDebuggerSession, method: string, params: unknown): Promise<{ accepted: boolean; rejectedSessionId?: string; targetId?: string; sessionId?: string; rootIdentityLost?: boolean }> {
    if (source.tabId === undefined || this.state(source.tabId) !== 'ATTACHED') return { accepted: false }
    const tracker = this.trackers.get(source.tabId)
    if (tracker === undefined) return { accepted: false }
    const payload = record(params)
    if (payload === null) return { accepted: false }
    if (source.sessionId === undefined) for (const signal of this.navigationSignals.get(source.tabId) ?? []) signal(method)
    if (method === 'Target.attachedToTarget') {
      let result = tracker.attached(source.sessionId, payload)
      if (!result.accepted && result.sessionId !== undefined) {
        // Dynamic OOPIF attachment can race the corresponding Page.frameAttached event.
        // Re-read Chrome's root frame tree and retry only after it proves ancestry.
        const frameTreeResult = record(await this.debuggerApi.sendCommand({ tabId: source.tabId }, 'Page.getFrameTree').catch(() => null))
        const frameTree = record(frameTreeResult?.frameTree)
        if (frameTree !== null) seedFrameTree(tracker, frameTree)
        result = tracker.attached(source.sessionId, payload)
      }
      if (!result.accepted && result.sessionId !== undefined) {
        await this.debuggerApi.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => undefined)
        return { accepted: false, rejectedSessionId: result.sessionId }
      }
      if (result.accepted && result.sessionId !== undefined) {
        await this.debuggerApi.sendCommand({ tabId: source.tabId, sessionId: result.sessionId }, 'Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
      }
      return {
        accepted: result.accepted,
        ...(result.targetId === undefined ? {} : { targetId: result.targetId }),
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      }
    }
    if (method === 'Target.detachedFromTarget') {
      if (typeof payload.sessionId === 'string') tracker.detached(payload.sessionId)
      return { accepted: true }
    }
    if (method === 'Target.targetInfoChanged') {
      if (source.sessionId !== undefined) {
        if (tracker.validatesTargetInfo(source.sessionId, payload.targetInfo)) return { accepted: true }
        await this.debuggerApi.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: source.sessionId }).catch(() => undefined)
        tracker.detached(source.sessionId)
        return { accepted: false, rejectedSessionId: source.sessionId }
      }
      try {
        const identity = await this.revalidateRoot(source.tabId)
        return { accepted: true, targetId: identity.targetId }
      } catch {
        return { accepted: false, rootIdentityLost: true }
      }
    }
    if (method === 'Page.frameAttached') {
      return { accepted: typeof payload.frameId === 'string' && tracker.frameAttached(payload.frameId, typeof payload.parentFrameId === 'string' ? payload.parentFrameId : null) }
    }
    if (source.sessionId !== undefined && !tracker.acceptsSession(source.sessionId)) return { accepted: false }
    if (method === 'Page.frameNavigated') {
      const frame = record(payload.frame)
      const isRootNavigation = source.sessionId === undefined && typeof frame?.parentId !== 'string'
      const isAcceptedChildNavigation = source.sessionId !== undefined
      if (isRootNavigation || isAcceptedChildNavigation) {
        this.navigationGenerations.set(source.tabId, this.navigationGeneration(source.tabId) + 1)
      }
    }
    const targetId = source.sessionId === undefined ? tracker.rootId() : tracker.targetIdForSession(source.sessionId)
    return { accepted: true, ...(targetId === null || targetId === undefined ? {} : { targetId }) }
  }

  onDetach(source: ChromeDebuggerTarget, reason: string): DebuggerDetachNotice | null {
    if (source.tabId === undefined) return null
    const previous = this.state(source.tabId)
    if (previous === 'UNATTACHED') return null
    const expected = previous === 'DETACHING'
    for (const signal of this.navigationSignals.get(source.tabId) ?? []) signal('Debugger.detached')
    this.navigationSignals.delete(source.tabId)
    if (expected) this.states.delete(source.tabId)
    else this.states.set(source.tabId, 'LOST')
    this.trackers.delete(source.tabId)
    this.navigationGenerations.set(source.tabId, this.navigationGeneration(source.tabId) + 1)
    const normalized = reason.toLowerCase()
    return {
      tabId: source.tabId,
      reason,
      expected,
      devtoolsContention: !expected && (normalized.includes('user') || normalized.includes('devtools') || normalized.includes('replaced')),
    }
  }
}
