import { useEffect, useMemo, useState } from 'react'
import { BrowserPanel, type BrowserWorkspaceCommandPort } from './BrowserPanel'
import type { BrowserWorkspaceCommand, ManagedBrowserWorkspaceProjection } from '@/lib/electron-bridge'

export function BrowserPopoutSurface() {
  const bridge = window.electronBridge?.browserWorkspace
  const [projection, setProjection] = useState<ManagedBrowserWorkspaceProjection | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) { setLoadError('Managed Browser projection bridge is unavailable.'); return }
    let active = true
    void bridge.getSnapshot().then((value) => { if (active) setProjection(value) }, (error) => {
      if (active) setLoadError(error instanceof Error ? error.message : String(error))
    })
    const offProjection = bridge.onProjection((value) => setProjection(value))
    return () => { active = false; offProjection() }
  }, [bridge])

  useEffect(() => {
    if (!bridge || !projection) return
    const report = (): void => {
      const target = document.querySelector('[data-browser-automation-viewport]')
      if (!(target instanceof HTMLElement)) return
      const rect = target.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      void bridge.reportViewport({
        workspaceEpoch: projection.workspaceEpoch,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1,
      }).catch(() => undefined)
    }
    const frame = requestAnimationFrame(report)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null
    const target = document.querySelector('[data-browser-automation-viewport]')
    if (target) observer?.observe(target)
    window.addEventListener('resize', report)
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', report) }
  }, [bridge, projection])

  const commandPort = useMemo<BrowserWorkspaceCommandPort | null>(() => {
    if (!bridge?.sendCommand || !projection?.sessionAgentId || !projection.profileId) return null
    const invoke = async (command: BrowserWorkspaceCommand): Promise<unknown> => bridge.sendCommand!({
      requestId: `popout-${crypto.randomUUID()}`,
      workspaceEpoch: projection.workspaceEpoch,
      sessionAgentId: projection.sessionAgentId!,
      profileId: projection.profileId!,
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      command,
    })
    return {
      open: async (autoOpenAttemptKey) => { await invoke({ type: 'open', ...(autoOpenAttemptKey ? { autoOpenAttemptKey } : {}) }) },
      activate: async (tabId) => { await invoke({ type: 'activate', tabId }) },
      close: async (tabId) => { await invoke({ type: 'close', tabId }) },
      resize: async (tabId, viewport) => { await invoke({ type: 'resize', tabId, viewport }) },
      navigate: async (tabId, url) => { await invoke({ type: 'navigate', tabId, url }) },
      history: async (tabId, direction) => { await invoke({ type: 'history', tabId, direction }) },
      reload: async (tabId, hard = false) => { await invoke({ type: 'reload', tabId, hard }) },
      zoom: async (tabId, factor) => { await invoke({ type: 'zoom', tabId, factor }) },
      capture: async (tabId) => String(await invoke({ type: 'capture', tabId })),
      startRecording: async (tabId) => { await invoke({ type: 'recordingStart', tabId }) },
      stopRecording: async (tabId, recordingId) => { await invoke({ type: 'recordingStop', tabId, recordingId }) },
      reveal: async () => { throw new Error('Chrome-backed tabs stay in the main Forge window.') },
      dock: async () => { await bridge.dock(projection.workspaceEpoch) },
    }
  }, [bridge, projection])

  if (loadError) return <SafeState title="Managed Browser unavailable" detail={loadError} />
  if (!projection) return <SafeState title="Connecting to Managed Browser…" detail="Waiting for the main Forge window." />
  if (!projection.sessionAgentId || !projection.profileId || !projection.snapshot) return <SafeState title="Select a local Builder manager" detail="Remote Projects and Collaboration cannot control this local browser." />
  if (!projection.connected || !commandPort) return <SafeState title="Browser host reconnecting" detail="The main Forge window remains the only browser and recording authority." />

  return (
    <main className="flex h-dvh min-w-0 overflow-hidden bg-background text-foreground">
      <BrowserPanel
        sessionAgentId={projection.sessionAgentId}
        profileId={projection.profileId}
        snapshot={projection.snapshot}
        host={projection.host}
        commandPort={commandPort}
        mode="popped-out"
        popoutAvailable={projection.popoutAvailable}
      />
    </main>
  )
}

function SafeState({ title, detail }: { title: string; detail: string }) {
  return <main className="flex h-dvh items-center justify-center bg-background p-8 text-center text-foreground"><div><h1 className="font-medium">{title}</h1><p className="mt-2 max-w-md text-sm text-muted-foreground">{detail}</p></div></main>
}
