import type { ChromeDebuggerApi, ChromeDebuggerSession, ChromeDebuggerTarget } from './chrome-api.js'

export type DebuggerState = 'UNATTACHED' | 'ATTACHING' | 'ATTACHED' | 'DETACHING' | 'LOST'

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
  devtoolsContention: boolean
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

  constructor(private readonly debuggerApi: ChromeDebuggerApi) {}

  state(tabId: number): DebuggerState {
    return this.states.get(tabId) ?? 'UNATTACHED'
  }

  tracker(tabId: number): OopifAncestryTracker | undefined {
    return this.trackers.get(tabId)
  }

  async reconcileForRelease(tabId: number, extensionId: string): Promise<void> {
    const target = (await this.debuggerApi.getTargets()).find((candidate) => candidate.tabId === tabId && candidate.attached === true)
    if (target === undefined) {
      this.states.set(tabId, 'UNATTACHED')
      this.trackers.delete(tabId)
      return
    }
    // Only positively adopt our own MV3 debugger attachment. Foreign ownership
    // remains LOST and Chrome detach must explicitly fail/ack before authority clears.
    this.states.set(tabId, target.extensionId === extensionId ? 'ATTACHED' : 'LOST')
  }

  async attach(tabId: number): Promise<void> {
    if (this.state(tabId) !== 'UNATTACHED') throw new Error(`debugger is ${this.state(tabId)}`)
    this.states.set(tabId, 'ATTACHING')
    const target: ChromeDebuggerTarget = { tabId }
    let didAttach = false
    try {
      await this.debuggerApi.attach(target, '1.3')
      didAttach = true
      const tracker = new OopifAncestryTracker()
      await this.debuggerApi.sendCommand(target, 'Page.enable')
      const targetInfoResult = record(await this.debuggerApi.sendCommand(target, 'Target.getTargetInfo'))
      const targetInfo = record(targetInfoResult?.targetInfo)
      const rootTargetId = typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : undefined
      if (rootTargetId === undefined) throw new Error('Chrome did not prove the root target identity')
      const frameTreeResult = record(await this.debuggerApi.sendCommand(target, 'Page.getFrameTree'))
      const frameTree = record(frameTreeResult?.frameTree)
      const rootFrame = record(frameTree?.frame)
      const rootFrameId = typeof rootFrame?.id === 'string' ? rootFrame.id : undefined
      tracker.registerRoot(rootTargetId, rootFrameId)
      if (frameTree !== null) seedFrameTree(tracker, frameTree)
      this.trackers.set(tabId, tracker)
      this.navigationGenerations.set(tabId, this.navigationGenerations.get(tabId) ?? 0)
      await this.debuggerApi.sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      this.states.set(tabId, 'ATTACHED')
    } catch (error) {
      this.states.set(tabId, 'UNATTACHED')
      this.trackers.delete(tabId)
      if (didAttach) {
        try { await this.debuggerApi.detach(target) } catch { /* best effort after partial attach */ }
      }
      throw error
    }
  }

  async sendCommand(tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.state(tabId) !== 'ATTACHED') throw new Error('debugger target is not attached')
    if (sessionId !== undefined && this.trackers.get(tabId)?.acceptsSession(sessionId) !== true) {
      throw new Error('debugger child session is outside the proven leased-root ancestry')
    }
    return this.debuggerApi.sendCommand({ tabId, ...(sessionId === undefined ? {} : { sessionId }) }, method, params)
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

  async navigateAndWait(
    tabId: number,
    url: string,
    readiness: 'load' | 'domContentLoaded' | 'none',
    deadlineAt: number,
    isAuthorized: () => boolean,
  ): Promise<void> {
    if (this.state(tabId) !== 'ATTACHED') throw new Error('debugger target is not attached')
    if (!isAuthorized()) throw new Error('lease authority was interrupted')
    if (readiness === 'none') {
      await this.debuggerApi.sendCommand({ tabId }, 'Page.navigate', { url })
      if (!isAuthorized()) throw new Error('lease authority was interrupted')
      return
    }
    const expected = readiness === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired'
    await new Promise<void>((resolve, reject) => {
      let settled = false
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
      const onSignal = (method: string): void => {
        if (method === expected) finish()
        else if (method === 'Debugger.detached') finish(new Error('debugger detached during navigation'))
      }
      const signals = this.navigationSignals.get(tabId) ?? new Set<(method: string) => void>()
      signals.add(onSignal)
      this.navigationSignals.set(tabId, signals)
      const remaining = Math.max(0, deadlineAt - Date.now())
      const deadlineTimer = setTimeout(() => finish(new Error(`navigation readiness ${readiness} timed out`)), remaining)
      const authorityTimer = setInterval(() => { if (!isAuthorized()) finish(new Error('lease authority was interrupted')) }, Math.min(25, Math.max(1, remaining)))
      void this.debuggerApi.sendCommand({ tabId }, 'Page.navigate', { url }).then(() => {
        if (!isAuthorized()) finish(new Error('lease authority was interrupted'))
      }, (error) => finish(error instanceof Error ? error : new Error(String(error))))
    })
  }

  async sendInput(tabId: number, method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText' | 'Input.dispatchTouchEvent', params: Record<string, unknown>): Promise<unknown> {
    if (this.state(tabId) !== 'ATTACHED') throw new Error('debugger input target is not attached')
    return this.debuggerApi.sendCommand({ tabId }, method, params)
  }

  async detach(tabId: number): Promise<void> {
    const state = this.state(tabId)
    if (state === 'UNATTACHED') return
    this.states.set(tabId, 'DETACHING')
    try {
      await this.debuggerApi.detach({ tabId })
    } catch (error) {
      // Chrome did not acknowledge debugger release. Retain our ownership model
      // so callers can retry instead of admitting new work through stale authority.
      this.states.set(tabId, state)
      throw error
    }
    this.states.set(tabId, 'UNATTACHED')
    this.trackers.delete(tabId)
    this.navigationGenerations.delete(tabId)
  }

  async detachAll(): Promise<void> {
    await Promise.allSettled([...this.states.keys()].map((tabId) => this.detach(tabId)))
  }

  targetId(tabId: number, sessionId?: string): string | undefined {
    const tracker = this.trackers.get(tabId)
    return sessionId === undefined ? tracker?.rootId() ?? undefined : tracker?.targetIdForSession(sessionId)
  }

  async onEvent(source: ChromeDebuggerSession, method: string, params: unknown): Promise<{ accepted: boolean; rejectedSessionId?: string; targetId?: string; sessionId?: string }> {
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
    if (method === 'Target.targetInfoChanged' && source.sessionId !== undefined) {
      if (tracker.validatesTargetInfo(source.sessionId, payload.targetInfo)) return { accepted: true }
      await this.debuggerApi.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: source.sessionId }).catch(() => undefined)
      tracker.detached(source.sessionId)
      return { accepted: false, rejectedSessionId: source.sessionId }
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
    for (const signal of this.navigationSignals.get(source.tabId) ?? []) signal('Debugger.detached')
    this.navigationSignals.delete(source.tabId)
    this.states.set(source.tabId, 'LOST')
    this.trackers.delete(source.tabId)
    this.navigationGenerations.set(source.tabId, this.navigationGeneration(source.tabId) + 1)
    const normalized = reason.toLowerCase()
    return {
      tabId: source.tabId,
      reason,
      devtoolsContention: normalized.includes('user') || normalized.includes('devtools') || normalized.includes('replaced'),
    }
  }
}
