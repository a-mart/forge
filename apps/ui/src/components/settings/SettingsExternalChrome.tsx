import { useCallback, useEffect, useState } from 'react'
import type { ExternalChromeCoordinatorStatus } from '@forge/protocol'
import { CheckCircle2, ChevronDown, ChevronUp, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './settings-row'

/** Setup and repair for the automatic Browser experience. Runtime target policy stays out of Settings. */
export function SettingsExternalChrome() {
  const bridge = typeof window === 'undefined' ? undefined : window.electronBridge?.externalChrome
  const [status, setStatus] = useState<ExternalChromeCoordinatorStatus | null>(null)
  const [loading, setLoading] = useState(Boolean(bridge))
  const [busy, setBusy] = useState<'enable' | 'repair' | 'reveal' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)

  const load = useCallback(async () => {
    if (!bridge) return
    setLoading(true)
    setError(null)
    try {
      const result = await bridge.status()
      if (!result.ok) throw new Error(result.error)
      setStatus(result.status)
    } catch {
      setError('Chrome setup status is unavailable. Restart Forge Desktop and try again.')
    } finally {
      setLoading(false)
    }
  }, [bridge])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (action: 'enable' | 'repair' | 'revealExtensionFolder') => {
    if (!bridge) return
    setBusy(action === 'revealExtensionFolder' ? 'reveal' : action)
    setError(null)
    try {
      const result = await bridge[action]()
      if (!result.ok) throw new Error(result.error)
      setStatus(result.status)
    } catch {
      setError(action === 'repair'
        ? 'Forge could not repair the Chrome connection. Open diagnostics and try again.'
        : 'Forge could not complete Chrome setup. Open diagnostics and try again.')
    } finally {
      setBusy(null)
    }
  }, [bridge])

  const ready = status?.state === 'online' && status.setup.pathState === 'ready'
  const connected = ready && status.auth === 'secure'
  const loadPath = status?.setup.pathState === 'ready' ? status.setup.loadUnpackedPath : undefined

  return (
    <SettingsSection
      label="Use Chrome with Forge"
      description="Optional. When Chrome is ready, Browser uses it automatically and falls back to the embedded browser when needed."
      cta={bridge ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading || busy !== null}>
          <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh
        </Button>
      ) : undefined}
    >
      {!bridge ? (
        <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          Chrome setup is available in the main Forge Desktop window.
        </p>
      ) : loading && !status ? (
        <p className="flex items-center py-6 text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Checking Chrome setup…</p>
      ) : status ? (
        <div className="space-y-4">
          <div className="rounded-md border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <CheckCircle2 className={`size-5 ${connected ? 'text-emerald-600' : 'text-muted-foreground'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{connected ? 'Chrome is ready for Forge' : ready ? 'Finish connecting Chrome' : 'Set up Chrome'}</p>
                <p className="text-xs text-muted-foreground">
                  {connected
                    ? 'No host or tab selection is required.'
                    : 'Load Forge’s extension once, then Forge handles browser tabs automatically.'}
                </p>
              </div>
              {!connected ? (
                <Button type="button" size="sm" onClick={() => void run(status.canEnable ? 'enable' : 'repair')} disabled={busy !== null || (!status.canEnable && !status.canRepair)}>
                  {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  {status.canEnable ? 'Use Chrome with Forge' : 'Repair'}
                </Button>
              ) : status.canRepair ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void run('repair')} disabled={busy !== null}>Repair</Button>
              ) : null}
            </div>

            {!connected && loadPath ? (
              <div className="mt-4 border-t pt-4 text-sm">
                <p className="font-medium">One-time Chrome step</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>Open <code className="rounded bg-muted px-1 text-foreground">chrome://extensions</code> and enable Developer mode.</li>
                  <li>Choose Load unpacked and select the Forge folder.</li>
                </ol>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void run('revealExtensionFolder')} disabled={!status.canReveal || busy !== null}>
                  <FolderOpen className="mr-1.5 size-3.5" />Show Forge extension folder
                </Button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="flex w-full items-center rounded px-1 py-1 text-left text-sm font-medium focus-visible:ring-2"
            aria-expanded={advanced}
            aria-controls="chrome-advanced-diagnostics"
            onClick={() => setAdvanced((value) => !value)}
          >
            Advanced diagnostics
            {advanced ? <ChevronUp className="ml-auto size-4" /> : <ChevronDown className="ml-auto size-4" />}
          </button>
          {advanced ? (
            <div id="chrome-advanced-diagnostics" className="space-y-2 rounded-md border bg-muted/20 p-4 text-xs text-muted-foreground">
              <p><span className="font-medium text-foreground">Coordinator:</span> {status.state}</p>
              <p><span className="font-medium text-foreground">Authentication:</span> {status.auth}</p>
              <p><span className="font-medium text-foreground">Recovery:</span> {status.recovery}</p>
              <p><span className="font-medium text-foreground">Extension:</span> {status.setup.extensionId}</p>
              {status.detail ? <p><span className="font-medium text-foreground">Detail:</span> {status.detail}</p> : null}
              <p>Chrome tabs remain in Chrome. Embedded-browser-only controls such as recording and viewport resize are hidden for Chrome-backed tabs.</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </SettingsSection>
  )
}
