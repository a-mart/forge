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
    if (sessionId === undefined || targetId === undefined || (type !== 'iframe' && type !== 'page')) return { accepted: false }
    const parentTargetId = sourceSessionId === undefined ? this.rootTargetId : this.targetBySession.get(sourceSessionId)
    if (parentTargetId === undefined || !this.isDescendantOrRoot(parentTargetId)) return { accepted: false, sessionId, targetId }
    const frameId = typeof targetInfo?.targetId === 'string' && type === 'iframe' ? targetInfo.targetId : undefined
    if (frameId !== undefined) {
      const frameParent = this.parentByFrame.get(frameId)
      if (frameParent !== undefined && frameParent !== null && !this.frameBelongsToKnownAncestry(frameParent)) {
        return { accepted: false, sessionId, targetId }
      }
    }
    this.nodes.set(targetId, { targetId, sessionId, parentTargetId, ...(frameId === undefined ? {} : { frameId }) })
    this.targetBySession.set(sessionId, targetId)
    return { accepted: true, sessionId, targetId }
  }

  frameAttached(frameId: string, parentFrameId: string | null): boolean {
    if (this.rootTargetId === null || frameId.length === 0) return false
    if (parentFrameId !== null && !this.frameBelongsToKnownAncestry(parentFrameId)) return false
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

export class DebuggerController {
  private readonly states = new Map<number, DebuggerState>()
  private readonly trackers = new Map<number, OopifAncestryTracker>()

  constructor(private readonly debuggerApi: ChromeDebuggerApi) {}

  state(tabId: number): DebuggerState {
    return this.states.get(tabId) ?? 'UNATTACHED'
  }

  tracker(tabId: number): OopifAncestryTracker | undefined {
    return this.trackers.get(tabId)
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
      const frameTreeResult = record(await this.debuggerApi.sendCommand(target, 'Page.getFrameTree'))
      const frameTree = record(frameTreeResult?.frameTree)
      const rootFrame = record(frameTree?.frame)
      const rootFrameId = typeof rootFrame?.id === 'string' ? rootFrame.id : undefined
      tracker.registerRoot(`tab:${tabId}`, rootFrameId)
      if (frameTree !== null) seedFrameTree(tracker, frameTree)
      this.trackers.set(tabId, tracker)
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

  async detach(tabId: number): Promise<void> {
    const state = this.state(tabId)
    if (state === 'UNATTACHED') return
    this.states.set(tabId, 'DETACHING')
    try {
      await this.debuggerApi.detach({ tabId })
    } finally {
      this.states.set(tabId, 'UNATTACHED')
      this.trackers.delete(tabId)
    }
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((tabId) => this.detach(tabId)))
  }

  async onEvent(source: ChromeDebuggerSession, method: string, params: unknown): Promise<{ accepted: boolean; rejectedSessionId?: string }> {
    if (source.tabId === undefined || this.state(source.tabId) !== 'ATTACHED') return { accepted: false }
    const tracker = this.trackers.get(source.tabId)
    if (tracker === undefined) return { accepted: false }
    const payload = record(params)
    if (payload === null) return { accepted: false }
    if (method === 'Target.attachedToTarget') {
      const result = tracker.attached(source.sessionId, payload)
      if (!result.accepted && result.sessionId !== undefined) {
        await this.debuggerApi.sendCommand({ tabId: source.tabId }, 'Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => undefined)
        return { accepted: false, rejectedSessionId: result.sessionId }
      }
      return { accepted: result.accepted }
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
    return { accepted: true }
  }

  onDetach(source: ChromeDebuggerTarget, reason: string): DebuggerDetachNotice | null {
    if (source.tabId === undefined) return null
    this.states.set(source.tabId, 'LOST')
    this.trackers.delete(source.tabId)
    const normalized = reason.toLowerCase()
    return {
      tabId: source.tabId,
      reason,
      devtoolsContention: normalized.includes('user') || normalized.includes('devtools') || normalized.includes('replaced'),
    }
  }
}
