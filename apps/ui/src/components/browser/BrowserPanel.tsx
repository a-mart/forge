import { useEffect, useState, type RefObject } from 'react'
import { ArrowLeft, ArrowRight, Camera, Circle, ExternalLink, Globe2, PanelTopClose, Plus, RefreshCw, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import {
  BROWSER_VIEWPORT_PRESETS,
  resolveBrowserViewportPreset,
  type BrowserHostConnectionSnapshot,
  type BrowserSessionSnapshot,
  type BrowserTabSnapshot,
  type BrowserViewportPresetId,
  type BrowserViewportSetting,
} from '@forge/protocol'
import type { BrowserAutomationHostHandle } from './BrowserAutomationHost'
import { HelpTrigger } from '@/components/help/HelpTrigger'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagedBrowserWorkspaceMode } from '@/lib/electron-bridge'
import { isElectron } from '@/lib/electron-bridge'
import { cn } from '@/lib/utils'

export interface BrowserWorkspaceCommandPort {
  open(): Promise<void>
  activate(tabId: string): Promise<void>
  close(tabId: string): Promise<void>
  resize(tabId: string, viewport: BrowserViewportSetting): Promise<void>
  navigate(tabId: string, url: string): Promise<void>
  history(tabId: string, direction: 'back' | 'forward'): Promise<void>
  reload(tabId: string, hard?: boolean): Promise<void>
  zoom(tabId: string, factor: number): Promise<void>
  capture(tabId: string): Promise<string>
  startRecording(tabId: string): Promise<void>
  stopRecording(tabId: string, recordingId: string): Promise<void>
  popOut?(): Promise<void>
  dock?(): Promise<void>
}

interface BrowserPanelProps {
  sessionAgentId: string
  profileId: string
  snapshot: BrowserSessionSnapshot | null
  host: BrowserHostConnectionSnapshot
  commandPort?: BrowserWorkspaceCommandPort
  mode?: ManagedBrowserWorkspaceMode
  popoutAvailable?: boolean
  /** @deprecated Local compatibility adapter; BrowserPanel itself never opens a transport. */
  client?: ManagerWsClient | null
  /** @deprecated Local compatibility adapter. */
  hostRef?: RefObject<BrowserAutomationHostHandle | null>
}

export function BrowserPanel({
  client = null, sessionAgentId, profileId, snapshot, host, hostRef, commandPort,
  mode = 'docked', popoutAvailable = Boolean(window.electronBridge?.browserWorkspace?.capability.popoutAvailable),
}: BrowserPanelProps) {
  const activeTab = snapshot?.tabs.find((tab) => tab.tabId === snapshot.activeTabId) ?? snapshot?.tabs[0] ?? null
  const [address, setAddress] = useState(activeTab?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [customWidth, setCustomWidth] = useState(1280)
  const [customHeight, setCustomHeight] = useState(800)
  useEffect(() => setAddress(activeTab?.url ?? ''), [activeTab?.tabId, activeTab?.url])

  const commands = commandPort ?? createLegacyLocalPort(client, sessionAgentId, profileId, hostRef)
  const unavailableMessage = !commandPort && !isElectron()
    ? 'Managed Browser is available in the Forge desktop app. This web session will not attempt local browser IPC.'
    : !host.connected
      ? 'The local browser host is reconnecting. Browser metadata remains visible but controls are unavailable.'
      : null
  const controlsUnavailable = unavailableMessage !== null
  const run = async (action: () => Promise<unknown> | unknown): Promise<void> => {
    setError(null)
    try { await action() } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
  }
  const resize = (viewport: BrowserViewportSetting): void => { if (activeTab) void run(() => commands.resize(activeTab.tabId, viewport)) }
  const popped = mode === 'popped-out' || mode === 'opening'

  return (
    <section className="relative flex min-h-0 flex-1 flex-col bg-background" aria-label="Managed Browser workspace">
      <div className="sr-only" aria-live="polite">{popped ? 'Managed Browser is open in a separate window.' : 'Managed Browser is docked in the main window.'}</div>
      <header className="border-b bg-muted/30">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 pt-2" role="tablist" aria-label="Browser tabs">
          {(snapshot?.tabs ?? []).filter((tab) => tab.lifecycle !== 'closed').map((tab) => (
            <div key={tab.tabId} className={cn('group flex min-w-32 max-w-56 items-center rounded-t-md border px-1', tab.tabId === activeTab?.tabId ? 'bg-background' : 'bg-muted/50')}>
              <button type="button" role="tab" aria-selected={tab.tabId === activeTab?.tabId} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={controlsUnavailable} onClick={() => void run(() => commands.activate(tab.tabId))}>
                {tab.loading ? 'Loading…' : tab.title || tab.url || 'New tab'}
              </button>
              <button type="button" aria-label={`Close ${tab.title || 'browser tab'}`} disabled={controlsUnavailable} className="rounded p-1 hover:bg-muted disabled:opacity-40 focus-visible:ring-2" onClick={() => void run(() => commands.close(tab.tabId))}><X className="size-3" /></button>
            </div>
          ))}
          <button type="button" aria-label="New browser tab" className="rounded p-2 hover:bg-muted focus-visible:ring-2" disabled={!host.connected} onClick={() => void run(() => commands.open())}><Plus className="size-4" /></button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 p-2">
          <IconButton label="Back" disabled={controlsUnavailable || !activeTab?.canGoBack} onClick={() => activeTab && void run(() => commands.history(activeTab.tabId, 'back'))}><ArrowLeft /></IconButton>
          <IconButton label="Forward" disabled={controlsUnavailable || !activeTab?.canGoForward} onClick={() => activeTab && void run(() => commands.history(activeTab.tabId, 'forward'))}><ArrowRight /></IconButton>
          <IconButton label="Reload" disabled={controlsUnavailable || !activeTab} onClick={() => activeTab && void run(() => commands.reload(activeTab.tabId))}><RefreshCw /></IconButton>
          <IconButton label="Hard reload" disabled={controlsUnavailable || !activeTab} onClick={() => activeTab && void run(() => commands.reload(activeTab.tabId, true))}><RotateCcw /></IconButton>
          <form className="flex min-w-48 flex-1" onSubmit={(event) => { event.preventDefault(); if (activeTab) void run(() => commands.navigate(activeTab.tabId, address)) }}>
            <label className="sr-only" htmlFor="browser-address">Address</label>
            <input id="browser-address" autoFocus={mode === 'popped-out'} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Enter URL" className="h-8 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={!activeTab || controlsUnavailable} />
          </form>
          <IconButton label="Zoom out" disabled={controlsUnavailable || !activeTab} onClick={() => activeTab && void run(() => commands.zoom(activeTab.tabId, activeTab.zoomFactor - .1))}><ZoomOut /></IconButton>
          <button type="button" aria-label="Reset zoom" title="Reset zoom" disabled={controlsUnavailable || !activeTab} className="w-11 rounded py-1 text-center text-xs tabular-nums hover:bg-muted disabled:opacity-40 focus-visible:ring-2" onClick={() => activeTab && void run(() => commands.zoom(activeTab.tabId, 1))}>{Math.round((activeTab?.zoomFactor ?? 1) * 100)}%</button>
          <IconButton label="Zoom in" disabled={controlsUnavailable || !activeTab} onClick={() => activeTab && void run(() => commands.zoom(activeTab.tabId, activeTab.zoomFactor + .1))}><ZoomIn /></IconButton>
          <IconButton label="Screenshot" disabled={controlsUnavailable || !activeTab} onClick={() => activeTab && void run(async () => setScreenshot(await commands.capture(activeTab.tabId)))}><Camera /></IconButton>
          <IconButton label={activeTab?.recording ? 'Stop recording' : 'Start recording'} disabled={controlsUnavailable || !activeTab || !host.capabilities?.supportsRecording} onClick={() => activeTab && void run(() => activeTab.recording ? commands.stopRecording(activeTab.tabId, activeTab.recording.recordingId) : commands.startRecording(activeTab.tabId))}><Circle className={cn(activeTab?.recording && 'fill-red-500 text-red-500')} /></IconButton>
          {popoutAvailable && (commands.popOut || commands.dock) ? (
            popped
              ? <IconButton label="Dock Managed Browser in main window" onClick={() => void run(() => commands.dock?.())}><PanelTopClose /></IconButton>
              : <IconButton label="Open Managed Browser in a separate window" onClick={() => void run(() => commands.popOut?.())}><ExternalLink /></IconButton>
          ) : null}
          <HelpTrigger contextKey="chat.browser" size="sm" className="size-8" />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5 text-xs">
          <label htmlFor="browser-viewport" className="text-muted-foreground">Viewport</label>
          <select id="browser-viewport" className="h-7 rounded border bg-background px-2" value={viewportSelectValue(activeTab?.viewportSetting)} onChange={(event) => {
            if (event.target.value === 'fill') resize({ mode: 'fill' })
            else if (event.target.value === 'freeform') resize({ mode: 'freeform', width: customWidth, height: customHeight })
            else resize(resolveBrowserViewportPreset(event.target.value as BrowserViewportPresetId))
          }} disabled={controlsUnavailable || !activeTab}>
            <option value="fill">Fill workspace</option><option value="freeform">Freeform</option>
            {Object.entries(BROWSER_VIEWPORT_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
          </select>
          <input id="browser-width" aria-label="Viewport width" type="number" min={240} max={3840} value={customWidth} disabled={controlsUnavailable} onChange={(event) => setCustomWidth(Number(event.target.value))} className="h-7 w-20 rounded border bg-background px-2 disabled:opacity-40" />
          <span aria-hidden="true">×</span>
          <input id="browser-height" aria-label="Viewport height" type="number" min={240} max={3840} value={customHeight} disabled={controlsUnavailable} onChange={(event) => setCustomHeight(Number(event.target.value))} className="h-7 w-20 rounded border bg-background px-2 disabled:opacity-40" />
          <button type="button" disabled={controlsUnavailable || !activeTab} className="h-7 rounded border px-2 hover:bg-muted disabled:opacity-40 focus-visible:ring-2" onClick={() => resize({ mode: 'freeform', width: customWidth, height: customHeight })}>Resize</button>
          {activeTab ? <TabStatus tab={activeTab} /> : null}
        </div>
      </header>

      {unavailableMessage ? (
        <div className="m-auto max-w-lg p-8 text-center"><Globe2 className="mx-auto mb-3 size-10 text-muted-foreground" /><h2 className="font-medium">Browser host unavailable</h2><p className="mt-2 text-sm text-muted-foreground">{unavailableMessage}</p></div>
      ) : activeTab ? (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-muted/40 p-2">
          <div className="relative min-w-0 flex-1">
            <div data-browser-automation-viewport className="h-full w-full rounded-md bg-white shadow-sm" aria-label="Browser content viewport" />
            {activeTab.loading ? <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary" /> : null}
          </div>
          {screenshot ? <ScreenshotPreview dataUrl={screenshot} onClose={() => setScreenshot(null)} /> : null}
        </div>
      ) : (
        <div className="m-auto text-center text-sm text-muted-foreground"><p>No browser tabs are open.</p><button type="button" className="mt-3 rounded border px-3 py-1.5 hover:bg-muted focus-visible:ring-2" onClick={() => void run(() => commands.open())}>Open a tab</button></div>
      )}
      {activeTab?.error ? <div role="alert" className="border-t bg-destructive/10 px-3 py-2 text-xs text-destructive">{activeTab.error.message}</div> : null}
      {error ? <div role="alert" className="border-t bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}
    </section>
  )
}

function createLegacyLocalPort(client: ManagerWsClient | null, sessionAgentId: string, profileId: string, hostRef?: RefObject<BrowserAutomationHostHandle | null>): BrowserWorkspaceCommandPort {
  const handle = () => { if (!hostRef?.current) throw new Error('Browser host is unavailable'); return hostRef.current }
  return {
    open: async () => { if (hostRef?.current) await hostRef.current.open(); else await client?.openBrowserTab(sessionAgentId, profileId, { activate: true }) },
    activate: async (tabId) => { if (hostRef?.current) await hostRef.current.activate(tabId); else await client?.activateBrowserTab(sessionAgentId, tabId) },
    close: async (tabId) => { if (hostRef?.current) await hostRef.current.close(tabId); else await client?.closeBrowserTab(sessionAgentId, tabId) },
    resize: async (tabId, viewport) => { if (hostRef?.current) await hostRef.current.resize(tabId, viewport); else await client?.resizeBrowserTab(sessionAgentId, tabId, viewport) },
    navigate: (tabId, url) => handle().navigate(tabId, url),
    history: async (tabId, direction) => handle().history(tabId, direction),
    reload: async (tabId, hard) => handle().reload(tabId, hard),
    zoom: async (tabId, factor) => handle().setZoom(tabId, factor),
    capture: (tabId) => handle().captureScreenshot(tabId),
    startRecording: async (tabId) => { if (hostRef?.current) await hostRef.current.startRecording(tabId); else await client?.startBrowserRecording(sessionAgentId, tabId) },
    stopRecording: async (tabId, recordingId) => { if (hostRef?.current) await hostRef.current.stopRecording(tabId, recordingId); else await client?.stopBrowserRecording(sessionAgentId, tabId, recordingId) },
    popOut: hostRef ? () => handle().popOut() : undefined,
    dock: hostRef ? () => handle().dock() : undefined,
  }
}
function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactElement<{ className?: string }> }) { return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="inline-flex size-8 items-center justify-center rounded hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 [&_svg]:size-4">{children}</button> }
function TabStatus({ tab }: { tab: BrowserTabSnapshot }) { const label = tab.controller === 'agent' ? 'Agent controlling' : tab.controller === 'human' ? 'Human controlling' : 'Ready'; return <span className="ml-auto flex items-center gap-1 text-muted-foreground"><span className={cn('size-1.5 rounded-full', tab.loading ? 'bg-amber-400' : tab.error ? 'bg-destructive' : 'bg-emerald-500')} />{label}{tab.recording ? ' · Recording' : ''}</span> }
function ScreenshotPreview({ dataUrl, onClose }: { dataUrl: string; onClose: () => void }) { return <aside aria-label="Browser screenshot" className="ml-2 flex w-80 shrink-0 flex-col rounded-lg border bg-background p-3 shadow"><div className="mb-2 flex items-center"><strong className="text-sm">Screenshot</strong><button type="button" aria-label="Close screenshot" className="ml-auto rounded p-1 hover:bg-muted" onClick={onClose}><X className="size-4" /></button></div><img src={dataUrl} alt="Captured browser viewport" className="min-h-0 flex-1 object-contain" /></aside> }
function viewportSelectValue(setting: BrowserViewportSetting | undefined): string { return setting?.mode === 'preset' ? setting.presetId : setting?.mode ?? 'fill' }
