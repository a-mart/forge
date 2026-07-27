import type {
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
} from '@forge/protocol'
import { WebContentsView, type BrowserWindow, type Event, type Input, type Rectangle } from 'electron'
import type { BrowserAutomationManager, BrowserWebContentsLike } from './browser-automation-manager.js'
import type { BrowserPresentationAcknowledgement, BrowserPresentationRequest } from './browser-bridge-contract.js'
import { BrowserHostError } from './browser-errors.js'
import type { BrowserSessionRegistry } from './browser-session.js'
import {
  isAllowedManagedBrowserUrl,
  managedBrowserWebPreferences,
  secureManagedBrowserWebContents,
} from './browser-webview-security.js'

export type ManagedBrowserOwner = 'docked' | 'popout'

export interface BrowserViewportMetrics {
  workspaceEpoch: number
  rect: { x: number; y: number; width: number; height: number }
  innerWidth: number
  innerHeight: number
  deviceScaleFactor?: number
}

export interface ManagedBrowserReconcileInput {
  controllerInstanceId: string
  hostGeneration: number
  updateSequence: number
  workspaceEpoch: number
  sessions: BrowserSessionSnapshot[]
}

interface OwnedTab {
  tab: BrowserTabSnapshot
  view: WebContentsView
  disposeSecurity: () => void
  provisional: boolean
  committedAtSequence: number | null
  closed: boolean
  incarnation: number
}

interface PresentationTarget {
  owner: ManagedBrowserOwner
  window: BrowserWindow
  metrics: BrowserViewportMetrics
}

/**
 * App-lifetime physical owner for managed tabs. A canonical tab has exactly one
 * WebContentsView/WebContents and is attached to at most one BrowserWindow.
 */
export class ManagedBrowserViewHost {
  private readonly tabs = new Map<string, OwnedTab>()
  private readonly desired = new Map<string, BrowserTabSnapshot>()
  private readonly targets = new Map<ManagedBrowserOwner, PresentationTarget>()
  private controllerInstanceId: string | null = null
  private hostGeneration = -1
  private updateSequence = -1
  private workspaceEpoch = 0
  private transferEpoch = 0
  private owner: ManagedBrowserOwner = 'docked'
  private attachedTabId: string | null = null
  private attachedWindow: BrowserWindow | null = null
  private transition: Promise<unknown> = Promise.resolve()
  private destroyed = false
  private incarnation = 0

  constructor(private readonly options: {
    manager: BrowserAutomationManager
    sessions: BrowserSessionRegistry
    guestPreloadPath: string
    onGuestBeforeInput?: (event: Event, input: Input) => void
    onGuestCrash?: (tabId: string, reason: string) => void
  }) {}

  get currentOwner(): ManagedBrowserOwner { return this.owner }
  get currentWorkspaceEpoch(): number { return this.workspaceEpoch }
  get tabCount(): number { return this.tabs.size }
  get currentAttachedTabId(): string | null { return this.attachedTabId }
  getTabWebContentsId(tabId: string): number | null {
    const owned = this.tabs.get(tabId)
    return owned && !owned.closed && !owned.view.webContents.isDestroyed() ? owned.view.webContents.id : null
  }
  hasPresentationTarget(owner: ManagedBrowserOwner, workspaceEpoch: number): boolean {
    const target = this.targets.get(owner)
    return Boolean(target && !target.window.isDestroyed() && target.metrics.workspaceEpoch === workspaceEpoch)
  }

  async reconcile(input: ManagedBrowserReconcileInput): Promise<{ applied: boolean; tabCount: number }> {
    return this.serialize(async () => {
      this.assertAlive()
      const authorityChanged = this.controllerInstanceId !== input.controllerInstanceId
        || this.hostGeneration !== input.hostGeneration
      if (!authorityChanged && input.updateSequence <= this.updateSequence) {
        return { applied: false, tabCount: this.tabs.size }
      }
      if (!Number.isSafeInteger(input.workspaceEpoch) || input.workspaceEpoch < this.workspaceEpoch) {
        return { applied: false, tabCount: this.tabs.size }
      }
      if (authorityChanged) {
        this.controllerInstanceId = input.controllerInstanceId
        this.hostGeneration = input.hostGeneration
        this.updateSequence = -1
      }
      this.updateSequence = input.updateSequence
      this.workspaceEpoch = input.workspaceEpoch

      this.options.manager.synchronizeSessions(input.sessions)
      const next = new Map<string, BrowserTabSnapshot>()
      for (const session of input.sessions) {
        if (session.hostingState !== 'hosted') continue
        for (const tab of session.tabs) {
          if (tab.targetAffinity === 'managed-electron' && tab.lifecycle !== 'closed') next.set(tab.tabId, tab)
        }
      }
      this.desired.clear()
      for (const [tabId, tab] of next) this.desired.set(tabId, tab)

      // Invalidate queued presentation before canonical close. Provisional tabs
      // are protected until commit/abort resolves their open request.
      for (const [tabId, owned] of [...this.tabs]) {
        const canonical = next.get(tabId)
        const explicitlyUnhosted = input.sessions.some((session) => session.sessionAgentId === owned.tab.sessionAgentId
          && session.hostingState !== 'hosted')
        const committedExpired = owned.committedAtSequence !== null && input.updateSequence > owned.committedAtSequence + 1
        if (!canonical && (!owned.provisional || explicitlyUnhosted || committedExpired)) this.closeOwnedTab(tabId)
        else if (canonical) { owned.tab = canonical; owned.provisional = false; owned.committedAtSequence = null }
      }
      for (const tab of next.values()) {
        if (!this.tabs.has(tab.tabId)) await this.createTab(tab, false)
      }
      return { applied: true, tabCount: this.tabs.size }
    })
  }

  async ensureProvisional(tab: BrowserTabSnapshot, workspaceEpoch: number): Promise<BrowserTabSnapshot> {
    return this.serialize(async () => {
      this.assertEpoch(workspaceEpoch)
      if (tab.targetAffinity !== 'managed-electron') {
        throw new BrowserHostError('invalid-input', 'Managed browser host cannot own an external Chrome tab')
      }
      const existing = this.tabs.get(tab.tabId)
      if (existing) {
        if (existing.tab.sessionAgentId !== tab.sessionAgentId || existing.tab.profileId !== tab.profileId) {
          throw new BrowserHostError('tab-session-mismatch', 'Provisional tab identity does not match the live tab')
        }
        return { ...existing.tab }
      }
      return this.createTab(tab, true)
    })
  }

  async commitProvisional(tabId: string, workspaceEpoch: number): Promise<void> {
    return this.serialize(() => {
      this.assertEpoch(workspaceEpoch)
      const owned = this.tabs.get(tabId)
      if (owned) owned.committedAtSequence = this.updateSequence
    })
  }

  async abortProvisional(tabId: string): Promise<void> {
    return this.serialize(() => this.closeOwnedTab(tabId))
  }

  setPresentationTarget(owner: ManagedBrowserOwner, window: BrowserWindow, metrics: BrowserViewportMetrics): void {
    if (this.destroyed || window.isDestroyed()) return
    if (!validMetrics(metrics) || metrics.workspaceEpoch < this.workspaceEpoch) return
    this.targets.set(owner, { owner, window, metrics })
  }

  invalidatePresentationTarget(owner: ManagedBrowserOwner): void {
    this.targets.delete(owner)
    if (this.owner === owner) this.transferEpoch += 1
  }

  async setOwner(owner: ManagedBrowserOwner, workspaceEpoch: number): Promise<void> {
    return this.serialize(() => {
      this.assertEpoch(workspaceEpoch)
      this.owner = owner
      this.transferEpoch += 1
    })
  }

  async transferOwner(owner: ManagedBrowserOwner, workspaceEpoch: number): Promise<boolean> {
    return this.serialize(() => {
      this.assertEpoch(workspaceEpoch)
      const target = this.targets.get(owner)
      if (!target || target.window.isDestroyed() || target.metrics.workspaceEpoch !== workspaceEpoch) return false
      this.owner = owner
      this.transferEpoch += 1
      if (!this.attachedTabId) return true
      const owned = this.tabs.get(this.attachedTabId)
      if (!owned || owned.closed) return false
      const bounds = calculateViewBounds(target.window, target.metrics, owned.tab.viewportSetting)
      if (!bounds) return false
      this.detachOwnedView(owned)
      target.window.contentView.addChildView(owned.view)
      owned.view.setBounds(bounds)
      owned.view.setVisible(true)
      this.attachedTabId = owned.tab.tabId
      this.attachedWindow = target.window
      return true
    })
  }

  async present(request: BrowserPresentationRequest & { workspaceEpoch: number }): Promise<BrowserPresentationAcknowledgement> {
    return this.serialize(() => {
      this.assertEpoch(request.workspaceEpoch)
      const owned = this.tabs.get(request.tabId)
      if (!owned || owned.closed || !this.desired.has(request.tabId) && !owned.provisional) {
        throw new BrowserHostError('tab-not-found', 'Managed browser tab is no longer hosted')
      }
      if (!request.visible) {
        if (this.attachedTabId === request.tabId) this.detachAttached()
        return this.options.manager.setTabPresentation({ ...request, renderedViewport: null, visible: false })
      }
      const target = this.targets.get(this.owner)
      if (!target || target.window.isDestroyed() || target.metrics.workspaceEpoch !== request.workspaceEpoch) {
        throw new BrowserHostError('invalid-input', 'Managed browser viewport is stale or unavailable')
      }
      const bounds = calculateViewBounds(target.window, target.metrics, owned.tab.viewportSetting)
      if (!bounds) throw new BrowserHostError('invalid-input', 'Managed browser viewport bounds are empty or invalid')
      if (this.attachedTabId && this.attachedTabId !== request.tabId) this.detachAttached()
      if (this.attachedWindow !== target.window || this.attachedTabId !== request.tabId) {
        this.detachOwnedView(owned)
        target.window.contentView.addChildView(owned.view)
      }
      owned.view.setBounds(bounds)
      owned.view.setVisible(true)
      this.attachedTabId = request.tabId
      this.attachedWindow = target.window
      // Presentation is layout/lifecycle reconciliation, not a user request to
      // focus guest content. Native clicks focus the view normally; explicit
      // keyboard automation focuses narrowly in BrowserAutomationManager.
      const renderedViewport = {
        width: bounds.width,
        height: bounds.height,
        deviceScaleFactor: target.metrics.deviceScaleFactor ?? 1,
      }
      return this.options.manager.setTabPresentation({ ...request, visible: true, renderedViewport })
    })
  }

  async captureScreenshot(tabId: string): Promise<string> {
    return this.options.manager.captureScreenshot(tabId)
  }

  async closeTab(tabId: string): Promise<void> {
    return this.serialize(() => {
      this.desired.delete(tabId)
      this.closeOwnedTab(tabId)
    })
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    await this.transition.catch(() => undefined)
    for (const tabId of [...this.tabs.keys()]) this.closeOwnedTab(tabId)
    this.targets.clear()
    await this.options.manager.destroy()
  }

  private async createTab(tab: BrowserTabSnapshot, provisional: boolean): Promise<BrowserTabSnapshot> {
    this.assertAlive()
    if (tab.targetAffinity !== 'managed-electron') {
      throw new BrowserHostError('invalid-input', 'Managed browser host cannot own an external Chrome tab')
    }
    if (!isAllowedManagedBrowserUrl(tab.url)) throw new BrowserHostError('invalid-url', 'Managed browser URLs must use HTTP or HTTPS')
    const view = new WebContentsView({
      webPreferences: managedBrowserWebPreferences(
        this.options.sessions.getSession(tab.profileId),
        this.options.guestPreloadPath,
      ),
    })
    const incarnation = ++this.incarnation
    const owned: OwnedTab = {
      tab,
      view,
      disposeSecurity: secureManagedBrowserWebContents(view.webContents),
      provisional,
      committedAtSequence: null,
      closed: false,
      incarnation,
    }
    this.tabs.set(tab.tabId, owned)
    this.options.manager.registerTabWebContents(
      { tab, visible: false, created: provisional },
      view.webContents as unknown as BrowserWebContentsLike,
    )
    const recover = (_event: unknown, details?: unknown): void => {
      const current = this.tabs.get(tab.tabId)
      if (!current || current.incarnation !== incarnation || current.closed || this.destroyed) return
      const reason = typeof details === 'object' && details && 'reason' in details
        ? String((details as { reason: unknown }).reason)
        : 'renderer process gone'
      this.options.manager.markGuestCrashed(tab.tabId, reason)
      this.detachOwnedView(current)
      current.disposeSecurity()
      current.closed = true
      this.tabs.delete(tab.tabId)
      this.options.onGuestCrash?.(tab.tabId, reason)
      const canonical = this.desired.get(tab.tabId)
      if (canonical) {
        void this.serialize(async () => {
          if (!this.destroyed && this.desired.has(tab.tabId) && !this.tabs.has(tab.tabId)) {
            await this.createTab(canonical, false)
          }
        })
      }
    }
    view.webContents.once('render-process-gone', recover)
    if (this.options.onGuestBeforeInput) {
      view.webContents.on('before-input-event', this.options.onGuestBeforeInput)
    }
    if (tab.url !== 'about:blank') void view.webContents.loadURL(tab.url).catch(() => undefined)
    return { ...tab, live: true }
  }

  private closeOwnedTab(tabId: string): void {
    const owned = this.tabs.get(tabId)
    if (!owned || owned.closed) return
    this.transferEpoch += 1
    owned.closed = true
    this.detachOwnedView(owned)
    owned.disposeSecurity()
    this.options.manager.unregisterTabWebContents(tabId, owned.view.webContents.id)
    this.tabs.delete(tabId)
    if (!owned.view.webContents.isDestroyed()) owned.view.webContents.close({ waitForBeforeUnload: false })
  }

  private detachAttached(): void {
    if (!this.attachedTabId) return
    const owned = this.tabs.get(this.attachedTabId)
    if (owned) {
      owned.view.setVisible(false)
      this.detachOwnedView(owned)
    }
    this.attachedTabId = null
    this.attachedWindow = null
  }

  private detachOwnedView(owned: OwnedTab): void {
    const windows = [...this.targets.values()].map((target) => target.window)
    if (this.attachedWindow) windows.push(this.attachedWindow)
    for (const window of new Set(windows)) {
      if (window.isDestroyed()) continue
      try { window.contentView.removeChildView(owned.view) } catch { /* already detached */ }
    }
    if (this.attachedTabId === owned.tab.tabId) {
      this.attachedTabId = null
      this.attachedWindow = null
    }
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.transition.then(operation, operation)
    this.transition = run.then(() => undefined, () => undefined)
    return run
  }

  private assertEpoch(epoch: number): void {
    this.assertAlive()
    if (!Number.isSafeInteger(epoch) || epoch !== this.workspaceEpoch) {
      throw new BrowserHostError('stale-host-generation', 'Managed browser workspace epoch is stale', true)
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new BrowserHostError('host-disconnected', 'Managed browser host is shutting down')
  }
}

export function calculateViewBounds(
  window: BrowserWindow,
  metrics: BrowserViewportMetrics,
  viewport: BrowserTabSnapshot['viewportSetting'],
): Rectangle | null {
  if (!validMetrics(metrics) || window.isDestroyed()) return null
  const content = window.getContentBounds()
  const scaleX = content.width / metrics.innerWidth
  const scaleY = content.height / metrics.innerHeight
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null
  const availableWidth = Math.max(0, Math.round(metrics.rect.width * scaleX))
  const availableHeight = Math.max(0, Math.round(metrics.rect.height * scaleY))
  let width = availableWidth
  let height = availableHeight
  if (viewport.mode !== 'fill') {
    width = Math.min(width, Math.round(viewport.width * scaleX))
    height = Math.min(height, Math.round(viewport.height * scaleY))
  }
  const x = Math.round(metrics.rect.x * scaleX + Math.max(0, (availableWidth - width) / 2))
  const y = Math.round(metrics.rect.y * scaleY + Math.max(0, (availableHeight - height) / 2))
  const clamped: Rectangle = {
    x: Math.max(0, Math.min(content.width - 1, x)),
    y: Math.max(0, Math.min(content.height - 1, y)),
    width: Math.max(0, Math.min(width, content.width - Math.max(0, x))),
    height: Math.max(0, Math.min(height, content.height - Math.max(0, y))),
  }
  return clamped.width > 0 && clamped.height > 0 ? clamped : null
}

export function validMetrics(metrics: BrowserViewportMetrics): boolean {
  const values = [
    metrics.workspaceEpoch,
    metrics.rect.x,
    metrics.rect.y,
    metrics.rect.width,
    metrics.rect.height,
    metrics.innerWidth,
    metrics.innerHeight,
  ]
  return values.every(Number.isFinite)
    && (metrics.deviceScaleFactor === undefined || (Number.isFinite(metrics.deviceScaleFactor) && metrics.deviceScaleFactor > 0))
    && Number.isSafeInteger(metrics.workspaceEpoch)
    && metrics.workspaceEpoch >= 0
    && metrics.rect.width > 0
    && metrics.rect.height > 0
    && metrics.innerWidth > 0
    && metrics.innerHeight > 0
}
