import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserTabSnapshot,
  BrowserViewportSetting,
} from '@forge/protocol'
import type { BrowserAutomationBridge, BrowserBridgeConfig } from '@/lib/electron-bridge'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'

interface ElectronWebviewElement extends HTMLElement {
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  capturePage(): Promise<{ toDataURL(): string }>
}

export interface BrowserAutomationHostHandle {
  navigate(tabId: string, url: string): Promise<void>
  history(tabId: string, direction: 'back' | 'forward'): void
  reload(tabId: string, hard?: boolean): void
  setZoom(tabId: string, factor: number): void
  captureScreenshot(tabId: string): Promise<string>
  toggleRecording(tab: BrowserTabSnapshot): Promise<BrowserAutomationResponse>
}

interface BrowserAutomationHostProps {
  client: ManagerWsClient | null
  state: ManagerWsState
  selectedSessionAgentId: string | null
  panelVisible: boolean
}

export const BrowserAutomationHost = forwardRef<BrowserAutomationHostHandle, BrowserAutomationHostProps>(
  function BrowserAutomationHost({ client, state, selectedSessionAgentId, panelVisible }, ref) {
    const bridge = typeof window !== 'undefined' ? window.electronBridge?.browserAutomation : undefined
    const [configs, setConfigs] = useState<Record<string, BrowserBridgeConfig>>({})
    const [provisionalTabs, setProvisionalTabs] = useState<Record<string, BrowserTabSnapshot>>({})
    const [viewportRect, setViewportRect] = useState<DOMRect | null>(null)
    const webviews = useRef(new Map<string, ElectronWebviewElement>())
    const readyPromises = useRef(new Map<string, Promise<void>>())
    const readyResolvers = useRef(new Map<string, () => void>())
    const visibleTabIds = useRef(new Set<string>())
    const sessionsRef = useRef(state.browserSessions)
    const bridgeRef = useRef(bridge)
    const clientRef = useRef(client)
    const hostIdRef = useRef(`forge-browser-${randomId()}`)

    useEffect(() => { sessionsRef.current = state.browserSessions }, [state.browserSessions])
    useEffect(() => { bridgeRef.current = bridge }, [bridge])
    useEffect(() => { clientRef.current = client }, [client])

    const tabs = useMemo(() => {
      const canonical = Object.values(state.browserSessions).flatMap((session) => session.tabs)
      const canonicalIds = new Set(canonical.map((tab) => tab.tabId))
      return [...canonical, ...Object.values(provisionalTabs).filter((tab) => !canonicalIds.has(tab.tabId))]
        .filter((tab) => tab.lifecycle !== 'closed')
    }, [provisionalTabs, state.browserSessions])

    useEffect(() => {
      setProvisionalTabs((current) => {
        const canonicalIds = new Set(Object.values(state.browserSessions).flatMap((session) => session.tabs.map((tab) => tab.tabId)))
        const next = Object.fromEntries(Object.entries(current).filter(([tabId]) => !canonicalIds.has(tabId)))
        return Object.keys(next).length === Object.keys(current).length ? current : next
      })
    }, [state.browserSessions])

    useEffect(() => {
      if (!bridge) return
      for (const profileId of new Set(tabs.map((tab) => tab.profileId))) {
        if (configs[profileId]) continue
        void bridge.getWebviewConfig(profileId).then((config) => {
          setConfigs((current) => current[profileId] ? current : { ...current, [profileId]: config })
        })
      }
    }, [bridge, configs, tabs])

    const executeRequest = useCallback(async (request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> => {
      const currentBridge = bridgeRef.current
      if (!currentBridge) throw new Error('Electron browser host is unavailable')
      let invokedRequest = request
      if (request.operation === 'open' && request.tabId === null) {
        const tab = createProvisionalTab(request.sessionAgentId, request.profileId, request.input.url)
        setProvisionalTabs((current) => ({ ...current, [tab.tabId]: tab }))
        if (!webviews.current.has(tab.tabId)) await waitUntilReady(tab.tabId, readyPromises.current, readyResolvers.current)
        invokedRequest = { ...request, tabId: tab.tabId, input: { ...request.input, tabId: tab.tabId } } as BrowserAutomationRequest
      } else if (request.tabId && !webviews.current.has(request.tabId)) {
        await waitUntilReady(request.tabId, readyPromises.current, readyResolvers.current)
      }
      const response = await currentBridge.invoke(invokedRequest)
      return invokedRequest === request ? response : { ...response, tabId: request.tabId }
    }, [])

    useEffect(() => {
      if (!client || !bridge) return
      const capabilities = bridge.capabilities
      const registration: BrowserHostRegistration = {
        hostId: hostIdRef.current,
        clientInstanceId: `renderer-${randomId()}`,
        capabilities: {
          supportedOperations: capabilities.supportedOperations as BrowserHostRegistration['capabilities']['supportedOperations'],
          electronVersion: 'desktop',
          chromiumVersion: 'embedded',
          playwrightVersion: capabilities.playwrightVersion,
          maxResponseBytes: 8 * 1024 * 1024,
          supportsSandboxedWebviews: true,
          supportsCapturePage: true,
          supportsRecording: capabilities.supportsRecording,
        },
        registeredAt: new Date().toISOString(),
      }
      return client.registerBrowserAutomationHost(registration, executeRequest)
    }, [bridge, client, executeRequest])

    useEffect(() => {
      if (!bridge || !client) return
      return bridge.onStateChanged((updatedTab) => {
        const sessions = sessionsRef.current
        const session = sessions[updatedTab.sessionAgentId]
        if (!session) return
        const nextSession = {
          ...session,
          tabs: session.tabs.map((tab) => tab.tabId === updatedTab.tabId ? updatedTab : tab),
        }
        client.reportBrowserHostState(Object.values({ ...sessions, [updatedTab.sessionAgentId]: nextSession }))
      })
    }, [bridge, client])

    useEffect(() => {
      if (!bridge || !client || state.browserHost.hostId !== hostIdRef.current || state.browserHost.hostGeneration === null) return
      const reportFocus = () => client.setBrowserHostFocused(document.visibilityState !== 'hidden' && document.hasFocus())
      reportFocus()
      window.addEventListener('focus', reportFocus)
      window.addEventListener('blur', reportFocus)
      document.addEventListener('visibilitychange', reportFocus)
      return () => {
        window.removeEventListener('focus', reportFocus)
        window.removeEventListener('blur', reportFocus)
        document.removeEventListener('visibilitychange', reportFocus)
      }
    }, [bridge, client, state.browserHost.hostGeneration, state.browserHost.hostId])

    useEffect(() => {
      const update = () => {
        const target = document.querySelector('[data-browser-automation-viewport]')
        setViewportRect(target instanceof HTMLElement ? target.getBoundingClientRect() : null)
      }
      update()
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
      const target = document.querySelector('[data-browser-automation-viewport]')
      if (target) observer?.observe(target)
      window.addEventListener('resize', update)
      return () => {
        observer?.disconnect()
        window.removeEventListener('resize', update)
      }
    }, [panelVisible, selectedSessionAgentId])

    useEffect(() => {
      if (!bridge) return
      for (const tab of tabs) {
        if (!webviews.current.has(tab.tabId)) continue
        const session = state.browserSessions[tab.sessionAgentId]
        const visible = Boolean(panelVisible && viewportRect && tab.sessionAgentId === selectedSessionAgentId && session?.activeTabId === tab.tabId)
        if (visible) visibleTabIds.current.add(tab.tabId)
        else visibleTabIds.current.delete(tab.tabId)
        void bridge.setTabPresentation(tab.tabId, visible, tab.viewportSetting).catch(() => undefined)
      }
    }, [bridge, panelVisible, selectedSessionAgentId, state.browserSessions, tabs, viewportRect])

    useImperativeHandle(ref, () => ({
      async navigate(tabId, rawUrl) {
        const webview = requireWebview(webviews.current, tabId)
        await webview.loadURL(normalizeUrl(rawUrl))
      },
      history(tabId, direction) {
        const webview = requireWebview(webviews.current, tabId)
        if (direction === 'back' && webview.canGoBack()) webview.goBack()
        if (direction === 'forward' && webview.canGoForward()) webview.goForward()
      },
      reload(tabId, hard = false) {
        const webview = requireWebview(webviews.current, tabId)
        if (hard) webview.reloadIgnoringCache()
        else webview.reload()
      },
      setZoom(tabId, factor) {
        requireWebview(webviews.current, tabId).setZoomFactor(Math.max(0.25, Math.min(3, factor)))
        const tab = Object.values(sessionsRef.current).flatMap((session) => session.tabs).find((candidate) => candidate.tabId === tabId)
        const currentBridge = bridgeRef.current
        if (tab && currentBridge) {
          void currentBridge.setTabPresentation(tabId, visibleTabIds.current.has(tabId), tab.viewportSetting).catch(() => undefined)
        }
      },
      async captureScreenshot(tabId) {
        return (await requireWebview(webviews.current, tabId).capturePage()).toDataURL()
      },
      async toggleRecording(tab) {
        const currentBridge = bridgeRef.current
        const host = clientRef.current?.getState().browserHost
        if (!currentBridge || !host?.hostId || host.hostGeneration === null) throw new Error('Browser host is unavailable')
        const operation = tab.recording ? 'recordingStop' : 'recordingStart'
        const request = {
          requestId: `human-${randomId()}`,
          sessionAgentId: tab.sessionAgentId,
          profileId: tab.profileId,
          tabId: tab.tabId,
          hostId: host.hostId,
          hostGeneration: host.hostGeneration,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          artifactDirectory: null,
          operation,
          input: tab.recording ? { tabId: tab.tabId, recordingId: tab.recording.recordingId } : { tabId: tab.tabId },
        } as BrowserAutomationRequest
        return currentBridge.invoke(request)
      },
    }), [])

    const handleWebviewReady = useCallback((tabId: string, element: ElectronWebviewElement) => {
      webviews.current.set(tabId, element)
      readyResolvers.current.get(tabId)?.()
    }, [])
    const handleWebviewUnmount = useCallback((tabId: string) => {
      webviews.current.delete(tabId)
    }, [])

    if (!bridge) return null

    return (
      <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden">
        {tabs.map((tab) => {
          const config = configs[tab.profileId]
          if (!config) return null
          const session = state.browserSessions[tab.sessionAgentId]
          const visible = Boolean(panelVisible && viewportRect && tab.sessionAgentId === selectedSessionAgentId && session?.activeTabId === tab.tabId)
          const style = webviewStyle(tab.viewportSetting, visible ? viewportRect : null)
          return (
            <HostedWebview
              key={tab.tabId}
              tab={tab}
              config={config}
              visible={visible}
              style={style}
              bridge={bridge}
              onReady={handleWebviewReady}
              onUnmount={handleWebviewUnmount}
            />
          )
        })}
      </div>
    )
  },
)

function HostedWebview({ tab, config, visible, style, bridge, onReady, onUnmount }: {
  tab: BrowserTabSnapshot
  config: BrowserBridgeConfig
  visible: boolean
  style: CSSProperties
  bridge: BrowserAutomationBridge
  onReady: (tabId: string, element: ElectronWebviewElement) => void
  onUnmount: (tabId: string) => void
}) {
  const [element, setElement] = useState<ElectronWebviewElement | null>(null)
  const initialTab = useRef(tab)
  useEffect(() => {
    if (!element) return
    const register = () => {
      void bridge.registerWebview({ tab: initialTab.current, webContentsId: element.getWebContentsId(), visible: false })
        .then(() => onReady(tab.tabId, element))
    }
    element.addEventListener('dom-ready', register)
    return () => {
      element.removeEventListener('dom-ready', register)
      onUnmount(tab.tabId)
      void bridge.unregisterWebview(tab.tabId, safeWebContentsId(element))
    }
  }, [bridge, element, onReady, onUnmount, tab.tabId])

  return createElement('webview', {
    ref: setElement,
    src: tab.url || 'about:blank',
    partition: config.partition,
    preload: config.preloadUrl,
    webpreferences: config.webPreferences,
    style,
    tabIndex: visible ? 0 : -1,
    'aria-label': tab.title || 'Managed browser tab',
  })
}

function webviewStyle(viewport: BrowserViewportSetting, rect: DOMRect | null): CSSProperties {
  if (!rect) return { position: 'fixed', left: -10_000, top: 0, width: viewportWidth(viewport), height: viewportHeight(viewport), pointerEvents: 'none' }
  const width = viewport.mode === 'fill' ? rect.width : Math.min(rect.width, viewport.width)
  const height = viewport.mode === 'fill' ? rect.height : Math.min(rect.height, viewport.height)
  return {
    position: 'fixed',
    left: rect.left + Math.max(0, (rect.width - width) / 2),
    top: rect.top + Math.max(0, (rect.height - height) / 2),
    width,
    height,
    pointerEvents: 'auto',
    background: 'white',
    borderRadius: 6,
  }
}
function viewportWidth(viewport: BrowserViewportSetting): number { return viewport.mode === 'fill' ? 1280 : viewport.width }
function viewportHeight(viewport: BrowserViewportSetting): number { return viewport.mode === 'fill' ? 800 : viewport.height }
function safeWebContentsId(element: ElectronWebviewElement): number | undefined { try { return element.getWebContentsId() } catch { return undefined } }
function requireWebview(map: Map<string, ElectronWebviewElement>, tabId: string): ElectronWebviewElement {
  const webview = map.get(tabId)
  if (!webview) throw new Error('Browser tab is not live')
  return webview
}
function waitUntilReady(tabId: string, promises: Map<string, Promise<void>>, resolvers: Map<string, () => void>): Promise<void> {
  const existing = promises.get(tabId)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { reject(new Error('Browser tab did not become ready')) }, 15_000)
    resolvers.set(tabId, () => { window.clearTimeout(timer); promises.delete(tabId); resolvers.delete(tabId); resolve() })
  })
  promises.set(tabId, promise)
  return promise
}
function createProvisionalTab(sessionAgentId: string, profileId: string, url?: string): BrowserTabSnapshot {
  const now = new Date().toISOString()
  return {
    tabId: `tab-${randomId()}`, sessionAgentId, profileId, url: url ? normalizeUrl(url) : 'about:blank', title: 'New tab',
    lifecycle: 'restoring', loading: false, live: false, canGoBack: false, canGoForward: false, zoomFactor: 1,
    controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null,
    error: null, createdAt: now, updatedAt: now,
  }
}
function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'about:blank') return 'about:blank'
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) throw new Error('Managed browser URLs must use HTTP or HTTPS')
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}
function randomId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
}
