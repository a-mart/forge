import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EXTERNAL_CHROME_M3_SUPPORTED_OPERATIONS, resolveBrowserHostKind } from '@forge/protocol'
import type {
  BrowserAutomationErrorCode,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserHostSessionStateReport,
  BrowserSessionSnapshot,
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
  open(autoOpenAttemptKey?: string): Promise<void>
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
    const externalHostIdRef = useRef(`forge-external-chrome-${randomId()}`)
    const controllerInstanceIdRef = useRef(`renderer-${randomId()}`)
    const workspaceEpochRef = useRef(Date.now())
    const reconcileSequenceRef = useRef(0)
    const presentationSequences = useRef(new Map<string, number>())
    const pendingTabUpdates = useRef(new Map<string, BrowserTabSnapshot>())
    const canonicalSessions = useRef(managedSessionMap(state.browserSessions))
    const projectedSessions = useRef(managedSessionMap(state.browserSessions))
    const reportInFlight = useRef(false)
    const reportTimer = useRef<number | null>(null)
    const runtimeUpdateSequence = useRef(0)
    const reportRetryState = useRef({ generation: null as number | null, conflicts: 0 })
    const disposed = useRef(false)
    const revealAcknowledgements = useRef(new Set<string>())
    const automaticEmptyOpenAttempts = useRef(new Set<string>())
    const [workspaceMode, setWorkspaceMode] = useState<ManagedBrowserWorkspaceMode>(workspace?.capability.popoutAvailable ? 'docked' : 'unavailable')
    const [externalRuntimeAvailable, setExternalRuntimeAvailable] = useState(false)
    const [externalRuntimeOperations, setExternalRuntimeOperations] = useState<BrowserHostRegistration['capabilities']['supportedOperations']>([])
    const [externalPayloadVersion, setExternalPayloadVersion] = useState('unknown')
    const workspaceModeRef = useRef<ManagedBrowserWorkspaceMode>(workspaceMode)

    useEffect(() => { bridgeRef.current = bridge }, [bridge])
    useEffect(() => { clientRef.current = client }, [client])
    useEffect(() => { stateRef.current = state }, [state])
    useEffect(() => {
      // Transport snapshots are authoritative, even when a restarted backend has
      // a lower revision than the previous process. Conflict snapshots can
      // temporarily be newer than this projection when its corresponding live
      // event was dropped; those are adopted directly in flushReports below.
      const nextProjected = managedSessionMap(state.browserSessions)
      let receivedCanonicalState = false
      for (const [sessionAgentId, session] of nextProjected) {
        if (session.tabs.some((tab) => tab.lifecycle !== 'closed')) {
          automaticEmptyOpenAttempts.current.delete(`${session.profileId}:${sessionAgentId}`)
        }
        // Preserve a conflict snapshot for one session when an unrelated
        // session changes. Reducer snapshots retain object identity for
        // untouched sessions, while hydration/restart replaces each object.
        if (projectedSessions.current.get(sessionAgentId) !== session || !canonicalSessions.current.has(sessionAgentId)) {
          canonicalSessions.current.set(sessionAgentId, session)
          receivedCanonicalState = true
        }
        if (session.hostingState !== 'hosted') dropPendingSession(pendingTabUpdates.current, sessionAgentId)
      }
      for (const sessionAgentId of projectedSessions.current.keys()) {
        if (!nextProjected.has(sessionAgentId)
          && (state.browserHostHydrated || state.browserSessions[sessionAgentId] !== undefined)) {
          canonicalSessions.current.delete(sessionAgentId)
          dropPendingSession(pendingTabUpdates.current, sessionAgentId)
          receivedCanonicalState = true
        }
      }
      projectedSessions.current = nextProjected
      if (receivedCanonicalState) reportRetryState.current.conflicts = 0
      if (state.browserHostHydrated) {
        for (const pending of pendingTabUpdates.current.values()) {
          if (!nextProjected.has(pending.sessionAgentId)) dropPendingSession(pendingTabUpdates.current, pending.sessionAgentId)
        }
      }
    }, [state.browserHostHydrated, state.browserSessions])
    useEffect(() => { selectedSessionRef.current = selectedSessionAgentId }, [selectedSessionAgentId])
    useEffect(() => { selectedProfileRef.current = selectedProfileId ?? null }, [selectedProfileId])

    const flushReports = useCallback(async () => {
      const currentClient = clientRef.current
      if (!currentClient || reportInFlight.current || pendingTabUpdates.current.size === 0) return
      const host = currentClient.getState().browserHost
      if (!host.connected || host.hostId !== hostIdRef.current || host.hostGeneration === null) return
      const reports = new Map<string, BrowserHostSessionStateReport>()
      const sent = new Map<string, BrowserTabSnapshot>()
      for (const updated of pendingTabUpdates.current.values()) {
        const session = canonicalSessions.current.get(updated.sessionAgentId)
        const canonical = session?.tabs.find((tab) => tab.tabId === updated.tabId)
        if (!session || session.hostingState !== 'hosted' || !canonical) {
          pendingTabUpdates.current.delete(updated.tabId)
          continue
        }
        const rebased = rebaseHostOwnedTabFields(canonical, updated)
        if (pendingTabUpdates.current.get(updated.tabId) === updated) pendingTabUpdates.current.set(updated.tabId, rebased)
        sent.set(updated.tabId, rebased)
        const existing = reports.get(session.sessionAgentId)
        reports.set(session.sessionAgentId, {
          sessionAgentId: session.sessionAgentId,
          profileId: session.profileId,
          baseRevision: session.revision,
          tabs: [...(existing?.tabs ?? []), rebased],
        })
      }
      if (reports.size === 0) return
      const generation = host.hostGeneration
      const updateSequence = runtimeUpdateSequence.current
      let conflictMadeProgress = false
      let sawConflict = false
      reportInFlight.current = true
      try {
        const result = await currentClient.reportBrowserHostState([...reports.values()])
        if (disposed.current || clientRef.current !== currentClient || result.hostId !== hostIdRef.current
          || result.hostGeneration !== generation || result.status === 'stale-host-generation') return
        for (const report of reports.values()) {
          const sessionResult = result.sessions.find((candidate) => candidate.sessionAgentId === report.sessionAgentId && candidate.profileId === report.profileId)
          if (!sessionResult) continue
          const managedSnapshot = sessionResult.snapshot ? managedSessionProjection(sessionResult.snapshot) : null
          if (managedSnapshot) canonicalSessions.current.set(report.sessionAgentId, managedSnapshot)
          if (sessionResult.status === 'accepted') {
            for (const tab of report.tabs) {
              if (pendingTabUpdates.current.get(tab.tabId) === sent.get(tab.tabId)) pendingTabUpdates.current.delete(tab.tabId)
            }
            if (managedSnapshot) rebasePendingSession(pendingTabUpdates.current, managedSnapshot)
            else dropPendingSession(pendingTabUpdates.current, report.sessionAgentId)
          } else if (sessionResult.status === 'revision-conflict') {
            sawConflict = true
            // A changed report base is real progress and warrants one rebased
            // attempt. An unchanged conflict waits for new canonical/runtime
            // state rather than polling the backend forever.
            if (sessionResult.snapshot.revision !== report.baseRevision) conflictMadeProgress = true
            if (managedSnapshot) rebasePendingSession(pendingTabUpdates.current, managedSnapshot)
            else dropPendingSession(pendingTabUpdates.current, report.sessionAgentId)
          } else if (sessionResult.status === 'rejected' && sessionResult.reason !== 'invalid-report') {
            dropPendingSession(pendingTabUpdates.current, report.sessionAgentId)
          }
        }
      } catch { /* a new transport generation or runtime update schedules the next attempt */ }
      finally {
        reportInFlight.current = false
        if (disposed.current) return
        if (runtimeUpdateSequence.current !== updateSequence) {
          reportRetryState.current.conflicts = 0
          scheduleReportTimer(flushReports, reportTimer)
        } else if (sawConflict) {
          reportRetryState.current.conflicts += 1
          if (conflictMadeProgress && pendingTabUpdates.current.size > 0
            && reportRetryState.current.conflicts < MAX_HOST_REPORT_CONFLICT_RETRIES) {
            scheduleReportTimer(flushReports, reportTimer)
          }
        } else {
          reportRetryState.current.conflicts = 0
        }
      }
    }, [])
    const scheduleReport = useCallback(() => scheduleReportTimer(flushReports, reportTimer), [flushReports])

    const executeRequest = useCallback(async (request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> => {
      const turnDisposition = externalTurnDisposition(request)
      if (turnDisposition) {
        const externalBridge = typeof window !== 'undefined' ? window.electronBridge?.externalChrome : undefined
        if (!externalBridge?.turnEnded || !request.tabId) return hostFailureResponse(request, new BrowserRendererError('host-disconnected', 'External Chrome turn bridge is unavailable'))
        const handedOff = await externalBridge.turnEnded({
          requestId: request.requestId, hostId: request.hostId, hostGeneration: request.hostGeneration,
          sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, ...turnDisposition,
        })
        if (!handedOff.ok) {
          const code: BrowserAutomationErrorCode = handedOff.error === 'stale-or-lost' ? 'lease-lost'
            : handedOff.error === 'invalid-request' ? 'invalid-input' : 'execution-failed'
          return hostFailureResponse(request, new BrowserRendererError(code, `External Chrome turn disposition failed: ${handedOff.error}`))
        }
        return {
          requestId: request.requestId, hostKind: request.hostKind, sessionAgentId: request.sessionAgentId,
          profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
          operation: 'status', ok: true, result: {
            available: handedOff.status.instances.length > 0,
            externalChromeTurnDisposition: turnDisposition,
            host: { hostKind: 'external-chrome', connected: handedOff.status.instances.length > 0, hostId: request.hostId, hostGeneration: request.hostGeneration, focused: false, capabilities: null, connectedAt: handedOff.status.instances[0]?.connectedAt ?? null },
            panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: null,
          }, elapsedMs: 0,
        }
      }
      const lifecycleRelease = externalLifecycleRelease(request)
      if (lifecycleRelease) {
        const externalBridge = typeof window !== 'undefined' ? window.electronBridge?.externalChrome : undefined
        if (!externalBridge?.releaseForLifecycle || !request.tabId) return hostFailureResponse(request, new BrowserRendererError('host-disconnected', 'External Chrome lifecycle release bridge is unavailable'))
        const released = await externalBridge.releaseForLifecycle({
          requestId: request.requestId, hostId: request.hostId, hostGeneration: request.hostGeneration,
          sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, ...lifecycleRelease,
        })
        if (!released.ok) {
          const code: BrowserAutomationErrorCode = released.error === 'stale-or-lost' ? 'lease-lost'
            : released.error === 'invalid-request' ? 'invalid-input' : 'execution-failed'
          return hostFailureResponse(request, new BrowserRendererError(code, `External Chrome lifecycle release failed: ${released.error}`))
        }
        return {
          requestId: request.requestId, hostKind: request.hostKind, sessionAgentId: request.sessionAgentId,
          profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
          operation: 'status', ok: true, result: {
            available: released.status.instances.length > 0,
            externalChromeLifecycleRelease: { phase: lifecycleRelease.phase, releaseId: lifecycleRelease.releaseId },
            host: { hostKind: 'external-chrome', connected: released.status.instances.length > 0, hostId: request.hostId, hostGeneration: request.hostGeneration, focused: false, capabilities: null, connectedAt: released.status.instances[0]?.connectedAt ?? null },
            panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: null,
          }, elapsedMs: 0,
        }
      }
      const currentBridge = bridgeRef.current
      if (!currentBridge) return hostFailureResponse(request, new Error('Electron browser host is unavailable'))
      let invoked = request
      let provisional: BrowserTabSnapshot | null = null
      try {
        if (request.hostKind === 'managed-electron' && request.operation === 'open' && request.tabId === null) {
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
        // The provisional tab is an Electron implementation detail. Broker
        // correlation always uses the caller's original open envelope (tabId
        // remains null), regardless of which provisional lifecycle phase failed.
        return hostFailureResponse(request, error)
      }
    }, [])

    useEffect(() => {
      if (!client || !bridge) return
      const registration: BrowserHostRegistration = {
        hostId: hostIdRef.current,
        clientInstanceId: controllerInstanceIdRef.current,
        capabilities: {
          hostKind: 'managed-electron',
          protocolVersions: { minimum: 1, maximum: 1 },
          supportedOperations: bridge.capabilities.supportedOperations as BrowserHostRegistration['capabilities']['supportedOperations'],
          runtimeVersions: { electron: 'desktop', chromium: 'embedded', playwright: bridge.capabilities.playwrightVersion },
          features: {
            resize: true, recording: bridge.capabilities.supportsRecording, capturePage: true,
            downloadEvents: false, downloadArtifacts: false, downloadOpen: false,
          },
          electronVersion: 'desktop', chromiumVersion: 'embedded', playwrightVersion: bridge.capabilities.playwrightVersion,
          maxResponseBytes: 8 * 1024 * 1024, supportsSandboxedWebviews: true, supportsCapturePage: true,
          supportsRecording: bridge.capabilities.supportsRecording,
        },
        registeredAt: new Date().toISOString(),
      }
      return client.registerBrowserAutomationHost(registration, executeRequest)
    }, [bridge, client, executeRequest])

    useEffect(() => {
      const external = typeof window !== 'undefined' && window.electronBridge?.windowRole === 'main'
        ? window.electronBridge.externalChrome
        : undefined
      if (!external?.localStatus || !selectedSessionAgentId || !selectedProfileId) return
      let disposed = false
      const inspect = async (): Promise<void> => {
        try {
          const result = await external.localStatus!(selectedSessionAgentId, selectedProfileId)
          const ready = result.ok && result.status.coordinator.state === 'online'
            && result.status.coordinator.setup.pathState === 'ready' && result.status.instances.length > 0
          // Once registered, retain the handler across runtime loss so status can report
          // available:false immediately instead of leaving a stale broker registration to time out.
          if (!disposed && ready) {
            const operationSets = result.status.instances.map((instance) => new Set(instance.supportedOperations ?? EXTERNAL_CHROME_M3_SUPPORTED_OPERATIONS))
            const supportedOperations = [...(operationSets[0] ?? new Set(EXTERNAL_CHROME_M3_SUPPORTED_OPERATIONS))]
              .filter((operation) => operationSets.every((operations) => operations.has(operation)))
            setExternalRuntimeOperations((current) => current.length === supportedOperations.length &&
              current.every((operation, index) => operation === supportedOperations[index]) ? current : supportedOperations)
            setExternalPayloadVersion(result.status.instances[0]?.payloadVersion ?? 'unknown')
            setExternalRuntimeAvailable(true)
          }
        } catch { /* initial registration remains gated; an existing handler stays live */ }
      }
      void inspect()
      const timer = window.setInterval(() => void inspect(), 3_000)
      return () => { disposed = true; window.clearInterval(timer) }
    }, [selectedProfileId, selectedSessionAgentId])

    useEffect(() => {
      if (!client || !bridge || !externalRuntimeAvailable || externalRuntimeOperations.length === 0 || typeof client.registerSecondaryBrowserAutomationHost !== 'function') return
      const registration: BrowserHostRegistration = {
        hostId: externalHostIdRef.current,
        clientInstanceId: controllerInstanceIdRef.current,
        capabilities: {
          hostKind: 'external-chrome', protocolVersions: { minimum: 1, maximum: 1 },
          supportedOperations: externalRuntimeOperations, maxResponseBytes: 1024 * 1024,
          runtimeVersions: { chrome: 'external', extension: externalPayloadVersion },
          // capturePage/supportsCapturePage are Managed Browser physical capture/export flags,
          // not the typed snapshot operation advertised in supportedOperations.
          features: {
            resize: false, recording: false, capturePage: false, downloadEvents: false,
            downloadArtifacts: false, downloadOpen: false,
          },
          supportsSandboxedWebviews: false, supportsCapturePage: false, supportsRecording: false,
        },
        registeredAt: new Date().toISOString(),
      }
      return client.registerSecondaryBrowserAutomationHost(registration, executeRequest)
    }, [bridge, client, executeRequest, externalPayloadVersion, externalRuntimeAvailable, externalRuntimeOperations])

    useEffect(() => {
      if (!bridge) return
      const sequence = ++reconcileSequenceRef.current
      void bridge.reconcile({
        controllerInstanceId: controllerInstanceIdRef.current,
        hostGeneration: state.browserHost.hostGeneration ?? 0,
        updateSequence: sequence,
        workspaceEpoch: workspaceEpochRef.current,
        sessions: [...managedSessionMap(state.browserSessions).values()],
      }).catch(() => undefined)
    }, [bridge, state.browserHost.hostGeneration, state.browserSessions])

    useEffect(() => {
      const generation = state.browserHost.hostId === hostIdRef.current ? state.browserHost.hostGeneration : null
      if (reportRetryState.current.generation !== generation) reportRetryState.current = { generation, conflicts: 0 }
      if (generation !== null && state.browserHostHydrated && pendingTabUpdates.current.size > 0
        && reportRetryState.current.conflicts < MAX_HOST_REPORT_CONFLICT_RETRIES) scheduleReport()
    }, [scheduleReport, state.browserHost.hostGeneration, state.browserHost.hostId, state.browserHostHydrated, state.browserSessions])

    useEffect(() => {
      if (!bridge || !client) return
      return bridge.onStateChanged((tab) => {
        if (resolveBrowserHostKind(tab.hostKind) !== 'managed-electron') return
        const session = canonicalSessions.current.get(tab.sessionAgentId)
          ?? managedSessionProjection(stateRef.current.browserSessions[tab.sessionAgentId])
        if (!session || session.hostingState !== 'hosted' || !session.tabs.some((candidate) => candidate.tabId === tab.tabId)) return
        pendingTabUpdates.current.set(tab.tabId, tab)
        runtimeUpdateSequence.current += 1
        reportRetryState.current.conflicts = 0
        scheduleReport()
      })
    }, [bridge, client, scheduleReport])

    useEffect(() => {
      disposed.current = false
      return () => {
        disposed.current = true
        clearReportTimer(reportTimer)
      }
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
      for (const session of managedSessionMap(state.browserSessions).values()) {
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
            runtimeUpdateSequence.current += 1
            reportRetryState.current.conflicts = 0
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
        case 'open': {
          const attemptKey = command.autoOpenAttemptKey
          if (attemptKey) {
            const attemptIdentity = `${profileId}:${sessionAgentId}`
            if (automaticEmptyOpenAttempts.current.has(attemptIdentity)) return
            // Mark before dispatching. A failed automatic attempt is deliberately
            // not retried; the panel's manual fallback remains available.
            automaticEmptyOpenAttempts.current.add(attemptIdentity)
          }
          return currentClient.openBrowserTab(sessionAgentId, profileId, { activate: true })
        }
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
      const snapshot = selectedSessionAgentId
        ? managedSessionProjection(state.browserSessions[selectedSessionAgentId])
        : null
      void workspace.publish({
        workspaceEpoch: workspaceEpochRef.current,
        sessionAgentId: snapshot ? selectedSessionAgentId : null,
        profileId: snapshot ? selectedProfileId ?? snapshot.profileId : null,
        snapshot,
        host: state.browserHost,
        mode: workspaceModeRef.current,
        popoutAvailable: workspace.capability.popoutAvailable,
        connected: Boolean(client && state.connected && selectedSessionAgentId && snapshot),
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
        const session = selectedSessionRef.current
          ? managedSessionProjection(stateRef.current.browserSessions[selectedSessionRef.current])
          : null
        if (workspace.publish) void workspace.publish({
          workspaceEpoch: workspaceEpochRef.current,
          sessionAgentId: session ? selectedSessionRef.current : null,
          profileId: session ? selectedProfileRef.current ?? session.profileId : null,
          snapshot: session,
          host: stateRef.current.browserHost,
          mode,
          popoutAvailable: workspace.capability.popoutAvailable,
          connected: Boolean(clientRef.current && stateRef.current.connected && selectedSessionRef.current && session),
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
      open: async (autoOpenAttemptKey) => { await executeWorkspaceCommand({ type: 'open', ...(autoOpenAttemptKey ? { autoOpenAttemptKey } : {}) }) },
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

const MAX_HOST_REPORT_CONFLICT_RETRIES = 3

function managedSessionProjection(session: BrowserSessionSnapshot | null | undefined): BrowserSessionSnapshot | null {
  if (!session || resolveBrowserHostKind(session.hostKind) !== 'managed-electron') return null
  const tabs = session.tabs.filter((tab) => resolveBrowserHostKind(tab.hostKind) === 'managed-electron')
  if (tabs.length === session.tabs.length) return session
  const tabIds = new Set(tabs.map((tab) => tab.tabId))
  return {
    ...session,
    tabs,
    activeTabId: session.activeTabId && tabIds.has(session.activeTabId) ? session.activeTabId : null,
    defaultTabId: session.defaultTabId && tabIds.has(session.defaultTabId) ? session.defaultTabId : null,
  }
}

function managedSessionMap(sessions: Record<string, BrowserSessionSnapshot>): Map<string, BrowserSessionSnapshot> {
  const managed = new Map<string, BrowserSessionSnapshot>()
  for (const [sessionAgentId, session] of Object.entries(sessions)) {
    const projected = managedSessionProjection(session)
    if (projected) managed.set(sessionAgentId, projected)
  }
  return managed
}

function scheduleReportTimer(flush: () => void | Promise<void>, timer: { current: number | null }): void {
  if (timer.current !== null) return
  timer.current = window.setTimeout(() => {
    timer.current = null
    void flush()
  }, 0)
}
function clearReportTimer(timer: { current: number | null }): void {
  if (timer.current === null) return
  window.clearTimeout(timer.current)
  timer.current = null
}
function dropPendingSession(pending: Map<string, BrowserTabSnapshot>, sessionAgentId: string): void {
  for (const [tabId, tab] of pending) {
    if (tab.sessionAgentId === sessionAgentId) pending.delete(tabId)
  }
}
function rebasePendingSession(pending: Map<string, BrowserTabSnapshot>, canonical: BrowserSessionSnapshot): void {
  if (canonical.hostingState !== 'hosted') {
    dropPendingSession(pending, canonical.sessionAgentId)
    return
  }
  for (const [tabId, updated] of pending) {
    if (updated.sessionAgentId !== canonical.sessionAgentId) continue
    const canonicalTab = canonical.tabs.find((tab) => tab.tabId === tabId)
    if (canonicalTab) pending.set(tabId, rebaseHostOwnedTabFields(canonicalTab, updated))
    else pending.delete(tabId)
  }
}

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
    hostKind: 'managed-electron',
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
    requestId: request.requestId, hostKind: request.hostKind, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId,
    hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false,
    error: {
      code: typeof failure?.code === 'string' ? failure.code as BrowserAutomationErrorCode : 'execution-failed',
      message: typeof failure?.message === 'string' ? failure.message : 'Browser host execution failed',
      retryable: failure?.retryable === true,
      ...(failure?.details && typeof failure.details === 'object' ? { details: failure.details as Record<string, string | number | boolean | null> } : {}),
    }, elapsedMs: 0,
  }
}
function externalTurnDisposition(request: BrowserAutomationRequest): { turnId: string; disposition: 'handoff' } | null {
  if (request.hostKind !== 'external-chrome' || request.operation !== 'status' || request.tabId === null) return null
  const turn = request.input.externalChromeTurnDisposition
  if (!turn || turn.disposition !== 'handoff' || !request.requestId.startsWith('external-chrome-turn-ended:')) return null
  return turn
}
function externalLifecycleRelease(request: BrowserAutomationRequest): {
  phase: 'prepare' | 'finalize'; releaseId: string; reason: 'stop' | 'archive' | 'delete' | 'detach' | 'host-replaced';
  originalHostId: string; originalHostGeneration: number
} | null {
  if (request.hostKind !== 'external-chrome' || request.operation !== 'status' || request.tabId === null) return null
  const lifecycle = request.input.externalChromeLifecycleRelease
  if (!lifecycle || !request.requestId.startsWith(`external-chrome-release:${lifecycle.phase}:${lifecycle.reason}:`)) return null
  return lifecycle
}
function randomId(): string { try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` } }
