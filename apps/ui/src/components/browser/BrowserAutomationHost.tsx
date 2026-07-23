import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type {
  BrowserAutomationErrorCode,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserHostSessionStateReport,
  BrowserTabSnapshot,
  BrowserViewportSetting,
} from '@forge/protocol'
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandRequest,
  ManagedBrowserWorkspaceMode,
} from '@/lib/electron-bridge'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'

export interface BrowserAutomationHostHandle {
  open(): Promise<void>
  activate(tabId: string): Promise<void>
  close(tabId: string): Promise<void>
  resize(tabId: string, viewport: BrowserViewportSetting): Promise<void>
  navigate(tabId: string, url: string): Promise<void>
  history(tabId: string, direction: 'back' | 'forward'): void
  reload(tabId: string, hard?: boolean): void
  setZoom(tabId: string, factor: number): void
  captureScreenshot(tabId: string): Promise<string>
  startRecording(tabId: string): Promise<void>
  stopRecording(tabId: string, recordingId: string): Promise<void>
  popOut(): Promise<void>
  dock(): Promise<void>
  bringToFront(): Promise<void>
}

interface BrowserAutomationHostProps {
  client: ManagerWsClient | null
  state: ManagerWsState
  selectedSessionAgentId: string | null
  selectedProfileId?: string | null
  panelVisible: boolean
  onWorkspaceModeChange?: (mode: ManagedBrowserWorkspaceMode) => void
}

export const BrowserAutomationHost = forwardRef<BrowserAutomationHostHandle, BrowserAutomationHostProps>(
  function BrowserAutomationHost({ client, state, selectedSessionAgentId, selectedProfileId, panelVisible, onWorkspaceModeChange }, ref) {
    const bridge = typeof window !== 'undefined' ? window.electronBridge?.browserAutomation : undefined
    const workspace = typeof window !== 'undefined' ? window.electronBridge?.browserWorkspace : undefined
    const bridgeRef = useRef(bridge)
    const clientRef = useRef(client)
    const stateRef = useRef(state)
    const selectedSessionRef = useRef(selectedSessionAgentId)
    const selectedProfileRef = useRef(selectedProfileId ?? null)
    const hostIdRef = useRef(`forge-browser-${randomId()}`)
    const controllerInstanceIdRef = useRef(`renderer-${randomId()}`)
    const workspaceEpochRef = useRef(Date.now())
    const reconcileSequenceRef = useRef(0)
    const presentationSequences = useRef(new Map<string, number>())
    const pendingTabUpdates = useRef(new Map<string, BrowserTabSnapshot>())
    const reportInFlight = useRef(false)
    const reportTimer = useRef<number | null>(null)
    const revealAcknowledgements = useRef(new Set<string>())
    const [workspaceMode, setWorkspaceMode] = useState<ManagedBrowserWorkspaceMode>(workspace?.capability.popoutAvailable ? 'docked' : 'unavailable')
    const workspaceModeRef = useRef<ManagedBrowserWorkspaceMode>(workspaceMode)

    useEffect(() => { bridgeRef.current = bridge }, [bridge])
    useEffect(() => { clientRef.current = client }, [client])
    useEffect(() => { stateRef.current = state }, [state])
    useEffect(() => { selectedSessionRef.current = selectedSessionAgentId }, [selectedSessionAgentId])
    useEffect(() => { selectedProfileRef.current = selectedProfileId ?? null }, [selectedProfileId])

    const flushReports = useCallback(async () => {
      const currentClient = clientRef.current
      const currentState = stateRef.current
      if (!currentClient || reportInFlight.current || pendingTabUpdates.current.size === 0) return
      const host = currentClient.getState().browserHost
      if (!host.connected || host.hostId !== hostIdRef.current || host.hostGeneration === null) return
      const reports = new Map<string, BrowserHostSessionStateReport>()
      const sent = new Map(pendingTabUpdates.current)
      for (const updated of sent.values()) {
        const session = currentState.browserSessions[updated.sessionAgentId]
        const canonical = session?.tabs.find((tab) => tab.tabId === updated.tabId)
        if (!session || session.hostingState !== 'hosted' || !canonical) {
          pendingTabUpdates.current.delete(updated.tabId)
          continue
        }
        const rebased = rebaseHostOwnedTabFields(canonical, updated)
        const existing = reports.get(session.sessionAgentId)
        reports.set(session.sessionAgentId, {
          sessionAgentId: session.sessionAgentId,
          profileId: session.profileId,
          baseRevision: session.revision,
          tabs: [...(existing?.tabs ?? []), rebased],
        })
      }
      if (reports.size === 0) return
      reportInFlight.current = true
      try {
        const result = await currentClient.reportBrowserHostState([...reports.values()])
        if (result.hostId !== hostIdRef.current || result.hostGeneration !== host.hostGeneration || result.status === 'stale-host-generation') return
        for (const report of reports.values()) {
          const sessionResult = result.sessions.find((candidate) => candidate.sessionAgentId === report.sessionAgentId)
          if (!sessionResult) continue
          if (sessionResult.status === 'accepted') {
            for (const tab of report.tabs) {
              if (pendingTabUpdates.current.get(tab.tabId) === sent.get(tab.tabId)) pendingTabUpdates.current.delete(tab.tabId)
            }
          } else if (sessionResult.status === 'rejected') {
            for (const tab of report.tabs) pendingTabUpdates.current.delete(tab.tabId)
          }
        }
      } catch { /* transport reconnect retries after the next state/runtime event */ }
      finally {
        reportInFlight.current = false
        if (pendingTabUpdates.current.size > 0 && reportTimer.current === null) {
          reportTimer.current = window.setTimeout(() => { reportTimer.current = null; void flushReports() }, 25)
        }
      }
    }, [])
    const scheduleReport = useCallback(() => {
      if (reportTimer.current !== null) return
      reportTimer.current = window.setTimeout(() => { reportTimer.current = null; void flushReports() }, 0)
    }, [flushReports])

    const executeRequest = useCallback(async (request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> => {
      const currentBridge = bridgeRef.current
      if (!currentBridge) return hostFailureResponse(request, new Error('Electron browser host is unavailable'))
      let invoked = request
      let provisional: BrowserTabSnapshot | null = null
      try {
        if (request.operation === 'open' && request.tabId === null) {
          provisional = createProvisionalTab(request.sessionAgentId, request.profileId, request.input.url)
          await currentBridge.ensureProvisional({ tab: provisional, visible: false, created: true, workspaceEpoch: workspaceEpochRef.current })
          invoked = { ...request, tabId: provisional.tabId, input: { ...request.input, tabId: provisional.tabId } } as BrowserAutomationRequest
        }
        const response = await currentBridge.invoke(invoked)
        if (provisional) {
          if (response.ok && response.operation === 'open') await currentBridge.commitProvisional(provisional.tabId, workspaceEpochRef.current)
          else await currentBridge.abortProvisional(provisional.tabId)
        }
        return invoked === request ? response : { ...response, tabId: request.tabId }
      } catch (error) {
        if (provisional) await currentBridge.abortProvisional(provisional.tabId).catch(() => undefined)
        return hostFailureResponse(invoked, error)
      }
    }, [])

    useEffect(() => {
      if (!client || !bridge) return
      const registration: BrowserHostRegistration = {
        hostId: hostIdRef.current,
        clientInstanceId: controllerInstanceIdRef.current,
        capabilities: {
          supportedOperations: bridge.capabilities.supportedOperations as BrowserHostRegistration['capabilities']['supportedOperations'],
          electronVersion: 'desktop', chromiumVersion: 'embedded', playwrightVersion: bridge.capabilities.playwrightVersion,
          maxResponseBytes: 8 * 1024 * 1024, supportsSandboxedWebviews: true, supportsCapturePage: true,
          supportsRecording: bridge.capabilities.supportsRecording,
        },
        registeredAt: new Date().toISOString(),
      }
      return client.registerBrowserAutomationHost(registration, executeRequest)
    }, [bridge, client, executeRequest])

    useEffect(() => {
      if (!bridge) return
      const sequence = ++reconcileSequenceRef.current
      void bridge.reconcile({
        controllerInstanceId: controllerInstanceIdRef.current,
        hostGeneration: state.browserHost.hostGeneration ?? 0,
        updateSequence: sequence,
        workspaceEpoch: workspaceEpochRef.current,
        sessions: Object.values(state.browserSessions),
      }).catch(() => undefined)
    }, [bridge, state.browserHost.hostGeneration, state.browserSessions])

    useEffect(() => {
      if (!bridge || !client) return
      return bridge.onStateChanged((tab) => {
        const session = stateRef.current.browserSessions[tab.sessionAgentId]
        if (!session || session.hostingState !== 'hosted' || !session.tabs.some((candidate) => candidate.tabId === tab.tabId)) return
        pendingTabUpdates.current.set(tab.tabId, tab)
        scheduleReport()
      })
    }, [bridge, client, scheduleReport])

    useEffect(() => () => {
      if (reportTimer.current !== null) window.clearTimeout(reportTimer.current)
    }, [])

    useEffect(() => {
      if (!bridge) return
      const update = (): void => {
        const target = document.querySelector('[data-browser-automation-viewport]')
        if (!(target instanceof HTMLElement)) return
        const rect = target.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        void bridge.reportViewport({
          workspaceEpoch: workspaceEpochRef.current,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio || 1,
        }).catch(() => undefined)
      }
      update()
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
      const target = document.querySelector('[data-browser-automation-viewport]')
      if (target) observer?.observe(target)
      window.addEventListener('resize', update)
      return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
    }, [bridge, panelVisible, selectedSessionAgentId, state.browserSessions, workspaceMode])

    useEffect(() => {
      if (!bridge) return
      const mode = workspaceMode
      const logicalVisible = mode === 'popped-out' || (mode !== 'opening' && mode !== 'docking' && panelVisible)
      for (const session of Object.values(state.browserSessions)) {
        if (session.hostingState !== 'hosted') continue
        for (const tab of session.tabs) {
          if (tab.lifecycle === 'closed') continue
          const visible = Boolean(logicalVisible && selectedSessionAgentId === session.sessionAgentId && session.activeTabId === tab.tabId)
          const sequence = (presentationSequences.current.get(tab.tabId) ?? 0) + 1
          presentationSequences.current.set(tab.tabId, sequence)
          void bridge.setTabPresentation({
            tabId: tab.tabId,
            visible,
            viewportSetting: tab.viewportSetting,
            renderedViewport: visible ? { width: 1, height: 1, deviceScaleFactor: window.devicePixelRatio || 1 } : null,
            hostGeneration: state.browserHost.hostGeneration ?? 0,
            sessionRevision: session.revision,
            sequence,
            workspaceEpoch: workspaceEpochRef.current,
          }).then((ack) => {
            if (!ack.applied || presentationSequences.current.get(tab.tabId) !== ack.sequence) return
            pendingTabUpdates.current.set(tab.tabId, ack.tab)
            scheduleReport()
            const currentClient = clientRef.current
            const reveal = currentClient?.getState().browserPanelRevealRequest
            if (!visible || !currentClient || !reveal || reveal.tabId !== tab.tabId || reveal.hostGeneration !== ack.hostGeneration) return
            const key = `${reveal.hostGeneration}:${reveal.sequence}:${reveal.tabId}`
            if (revealAcknowledgements.current.has(key)) return
            revealAcknowledgements.current.add(key)
            void currentClient.acknowledgeBrowserPanelReveal({
              sessionAgentId: reveal.sessionAgentId, profileId: reveal.profileId, tabId: reveal.tabId, sequence: reveal.sequence,
            }).catch(() => revealAcknowledgements.current.delete(key))
          }).catch(() => undefined)
        }
      }
    }, [bridge, panelVisible, scheduleReport, selectedSessionAgentId, state.browserHost.hostGeneration, state.browserSessions, workspaceMode])

    const executeWorkspaceCommand = useCallback(async (command: BrowserWorkspaceCommand): Promise<unknown> => {
      const currentClient = clientRef.current
      const sessionAgentId = selectedSessionRef.current
      const profileId = selectedProfileRef.current
      const currentBridge = bridgeRef.current
      if (!currentClient || !sessionAgentId || !profileId || !currentBridge) throw new Error('Selected local Managed Browser is unavailable')
      switch (command.type) {
        case 'open': return currentClient.openBrowserTab(sessionAgentId, profileId, { activate: true })
        case 'activate': return currentClient.activateBrowserTab(sessionAgentId, command.tabId)
        case 'close': return currentClient.closeBrowserTab(sessionAgentId, command.tabId)
        case 'resize': return currentClient.resizeBrowserTab(sessionAgentId, command.tabId, command.viewport)
        case 'navigate': return currentBridge.navigate(command.tabId, normalizeUrl(command.url))
        case 'history': return currentBridge.history(command.tabId, command.direction)
        case 'reload': return currentBridge.reload(command.tabId, command.hard)
        case 'zoom': return currentBridge.setZoom(command.tabId, Math.max(.25, Math.min(3, command.factor)))
        case 'capture': return currentBridge.captureScreenshot(command.tabId)
        case 'recordingStart': return currentClient.startBrowserRecording(sessionAgentId, command.tabId)
        case 'recordingStop': return currentClient.stopBrowserRecording(sessionAgentId, command.tabId, command.recordingId)
      }
    }, [])

    useEffect(() => {
      if (!workspace?.onCommand || !workspace.replyToCommand) return
      return workspace.onCommand((request: BrowserWorkspaceCommandRequest) => {
        if (request.workspaceEpoch !== workspaceEpochRef.current
          || request.sessionAgentId !== selectedSessionRef.current
          || request.profileId !== selectedProfileRef.current) {
          workspace.replyToCommand?.(request.requestId, { ok: false, error: 'Browser workspace command is stale' })
          return
        }
        void executeWorkspaceCommand(request.command).then(
          (value) => workspace.replyToCommand?.(request.requestId, { ok: true, value }),
          (error) => workspace.replyToCommand?.(request.requestId, { ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
      })
    }, [executeWorkspaceCommand, workspace])

    useEffect(() => {
      if (!workspace?.publish) return
      const snapshot = selectedSessionAgentId ? state.browserSessions[selectedSessionAgentId] ?? null : null
      void workspace.publish({
        workspaceEpoch: workspaceEpochRef.current,
        sessionAgentId: selectedSessionAgentId,
        profileId: selectedProfileId ?? snapshot?.profileId ?? null,
        snapshot,
        host: state.browserHost,
        mode: workspaceModeRef.current,
        popoutAvailable: workspace.capability.popoutAvailable,
        connected: Boolean(client && state.connected && selectedSessionAgentId),
        publishedAt: new Date().toISOString(),
      }).catch(() => undefined)
    }, [client, selectedProfileId, selectedSessionAgentId, state.browserHost, state.browserSessions, state.connected, workspace])

    useEffect(() => {
      if (!workspace) return
      return workspace.onModeChanged((mode) => {
        workspaceModeRef.current = mode
        setWorkspaceMode(mode)
        onWorkspaceModeChange?.(mode)
        // Native owner changed without a host generation change. Re-publish and
        // let the presentation effect verify non-empty physical bounds.
        const session = selectedSessionRef.current ? stateRef.current.browserSessions[selectedSessionRef.current] : null
        if (workspace.publish) void workspace.publish({
          workspaceEpoch: workspaceEpochRef.current,
          sessionAgentId: selectedSessionRef.current,
          profileId: selectedProfileRef.current,
          snapshot: session ?? null,
          host: stateRef.current.browserHost,
          mode,
          popoutAvailable: workspace.capability.popoutAvailable,
          connected: Boolean(clientRef.current && stateRef.current.connected && selectedSessionRef.current),
          publishedAt: new Date().toISOString(),
        }).catch(() => undefined)
      })
    }, [onWorkspaceModeChange, workspace])

    useEffect(() => {
      if (!client || state.browserHost.hostId !== hostIdRef.current || state.browserHost.hostGeneration === null) return
      if (workspace?.onFocusChanged) return workspace.onFocusChanged((focused) => client.setBrowserHostFocused(focused))
      const report = () => client.setBrowserHostFocused(document.visibilityState !== 'hidden' && document.hasFocus())
      report(); window.addEventListener('focus', report); window.addEventListener('blur', report); document.addEventListener('visibilitychange', report)
      return () => { window.removeEventListener('focus', report); window.removeEventListener('blur', report); document.removeEventListener('visibilitychange', report) }
    }, [client, state.browserHost.hostGeneration, state.browserHost.hostId, workspace])

    useImperativeHandle(ref, () => ({
      open: async () => { await executeWorkspaceCommand({ type: 'open' }) },
      activate: async (tabId) => { await executeWorkspaceCommand({ type: 'activate', tabId }) },
      close: async (tabId) => { await executeWorkspaceCommand({ type: 'close', tabId }) },
      resize: async (tabId, viewport) => { await executeWorkspaceCommand({ type: 'resize', tabId, viewport }) },
      navigate: async (tabId, url) => { await executeWorkspaceCommand({ type: 'navigate', tabId, url }) },
      history: (tabId, direction) => { void executeWorkspaceCommand({ type: 'history', tabId, direction }) },
      reload: (tabId, hard = false) => { void executeWorkspaceCommand({ type: 'reload', tabId, hard }) },
      setZoom: (tabId, factor) => { void executeWorkspaceCommand({ type: 'zoom', tabId, factor }) },
      captureScreenshot: async (tabId) => String(await executeWorkspaceCommand({ type: 'capture', tabId })),
      startRecording: async (tabId) => { await executeWorkspaceCommand({ type: 'recordingStart', tabId }) },
      stopRecording: async (tabId, recordingId) => { await executeWorkspaceCommand({ type: 'recordingStop', tabId, recordingId }) },
      popOut: async () => { await workspace?.popOut(workspaceEpochRef.current) },
      dock: async () => { await workspace?.dock(workspaceEpochRef.current) },
      bringToFront: async () => { await workspace?.bringToFront() },
    }), [executeWorkspaceCommand, workspace])

    return null
  },
)

function rebaseHostOwnedTabFields(canonical: BrowserTabSnapshot, updated: BrowserTabSnapshot): BrowserTabSnapshot {
  return {
    ...canonical,
    url: updated.url, title: updated.title, lifecycle: updated.lifecycle, loading: updated.loading, live: updated.live,
    canGoBack: updated.canGoBack, canGoForward: updated.canGoForward, zoomFactor: updated.zoomFactor,
    controller: updated.controller, agentCursor: updated.agentCursor, recording: updated.recording,
    viewportSetting: updated.viewportSetting, renderedViewport: updated.renderedViewport,
    ...(updated.physicalVisible !== undefined ? { physicalVisible: updated.physicalVisible } : {}),
    error: updated.error, updatedAt: updated.updatedAt,
  }
}
function createProvisionalTab(sessionAgentId: string, profileId: string, url?: string): BrowserTabSnapshot {
  const now = new Date().toISOString()
  return {
    tabId: `tab-${randomId()}`, sessionAgentId, profileId, url: url ? normalizeUrl(url) : 'about:blank', title: 'New tab',
    lifecycle: 'restoring', loading: false, live: false, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null,
    physicalVisible: false, error: null, createdAt: now, updatedAt: now,
  }
}
function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'about:blank') return 'about:blank'
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) throw new BrowserRendererError('invalid-url', 'Managed browser URLs must use HTTP or HTTPS')
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}
class BrowserRendererError extends Error {
  readonly retryable = false
  constructor(readonly code: BrowserAutomationErrorCode, message: string, readonly details?: Record<string, string | number | boolean | null>) { super(message); this.name = 'BrowserRendererError' }
}
function hostFailureResponse(request: BrowserAutomationRequest, error: unknown): BrowserAutomationResponse {
  const failure = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } : null
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId,
    hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false,
    error: {
      code: typeof failure?.code === 'string' ? failure.code as BrowserAutomationErrorCode : 'execution-failed',
      message: typeof failure?.message === 'string' ? failure.message : 'Browser host execution failed',
      retryable: failure?.retryable === true,
      ...(failure?.details && typeof failure.details === 'object' ? { details: failure.details as Record<string, string | number | boolean | null> } : {}),
    }, elapsedMs: 0,
  }
}
function randomId(): string { try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` } }
