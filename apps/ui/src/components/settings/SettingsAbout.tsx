import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, RotateCcw, AlertCircle, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from './settings-row'
import { fetchServerVersion } from './settings-api'
import type { SettingsApiClient } from './settings-api-client'
import { isElectron, type UpdateStatus } from '@/lib/electron-bridge'

interface SettingsAboutProps {
  wsUrl: string
  apiClient?: SettingsApiClient
}

export function SettingsAbout({ wsUrl, apiClient }: SettingsAboutProps) {
  const bridge = window.electronBridge
  const inElectron = isElectron()
  const clientOrWsUrl: SettingsApiClient | string = apiClient ?? wsUrl
  const [webVersion, setWebVersion] = useState<string | null>(null)
  const version = inElectron ? (bridge?.getVersion?.() ?? null) : webVersion
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [betaChannel, setBetaChannel] = useState(false)
  const [betaLoaded, setBetaLoaded] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!inElectron || !bridge?.onUpdateStatus) {
      return
    }

    cleanupRef.current = bridge.onUpdateStatus((s) => {
      setStatus(s)
    })

    return () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [inElectron, bridge])

  useEffect(() => {
    if (!inElectron || !bridge?.getBetaChannel) {
      return
    }

    bridge.getBetaChannel().then((enabled) => {
      setBetaChannel(enabled)
      setBetaLoaded(true)
    }).catch(() => {
      setBetaLoaded(true)
    })
  }, [inElectron, bridge])

  useEffect(() => {
    if (inElectron) {
      return
    }

    let cancelled = false
    fetchServerVersion(clientOrWsUrl).then((resolvedVersion) => {
      if (!cancelled) {
        setWebVersion(resolvedVersion)
      }
    }).catch(() => {
      if (!cancelled) {
        setWebVersion(null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [inElectron, clientOrWsUrl])

  const handleCheckForUpdates = useCallback(() => {
    bridge?.checkForUpdates?.()
  }, [bridge])

  const handleDownload = useCallback(() => {
    bridge?.downloadUpdate?.()
  }, [bridge])

  const handleInstall = useCallback(() => {
    bridge?.installUpdate?.()
  }, [bridge])

  const handleBetaToggle = useCallback((checked: boolean) => {
    setBetaChannel(checked)
    bridge?.setBetaChannel?.(checked)
  }, [bridge])

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection label="About Forge">
        <div className="flex flex-col gap-6">
          {/* Version */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Version</span>
            <Badge variant="secondary" className="font-mono text-xs">
              {version ? `v${version}` : 'Unknown'}
            </Badge>
          </div>

          {/* Releases link */}
          <a
            href="https://github.com/a-mart/forge/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            View releases on GitHub
            <ExternalLink className="size-3.5" />
          </a>

          {/* Updates */}
          {inElectron ? (
            <div className="flex flex-col gap-4">
              <UpdateStatusDisplay
                status={status}
                onCheckForUpdates={handleCheckForUpdates}
                onDownload={handleDownload}
                onInstall={handleInstall}
              />

              {/* Beta channel toggle */}
              {betaLoaded && (
                <div className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">Include beta updates</span>
                    <span className="text-xs text-muted-foreground">
                      Get early access to new features. Beta releases may be less stable.
                    </span>
                  </div>
                  <Switch
                    checked={betaChannel}
                    onCheckedChange={handleBetaToggle}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe className="size-4 shrink-0" />
              <span>Running in browser — updates are managed separately.</span>
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}

function UpdateStatusDisplay({
  status,
  onCheckForUpdates,
  onDownload,
  onInstall,
}: {
  status: UpdateStatus | null
  onCheckForUpdates: () => void
  onDownload: () => void
  onInstall: () => void
}) {
  const type = status?.type ?? null

  return (
    <div className="flex flex-col gap-3">
      {/* Status line */}
      <div className="flex items-center gap-2 min-h-[24px]">
        {type === 'checking' && (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Checking for updates…</span>
          </>
        )}

        {type === 'not-available' && (
          <>
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
            <span className="text-sm text-muted-foreground">You&apos;re up to date</span>
          </>
        )}

        {type === 'available' && status?.type === 'available' && (
          <>
            <Download className="size-4 shrink-0 text-blue-500" />
            <span className="text-sm">
              Update available: <span className="font-mono font-medium">v{status.version}</span>
            </span>
          </>
        )}

        {type === 'downloading' && status?.type === 'downloading' && (
          <>
            <Loader2 className="size-4 shrink-0 animate-spin text-blue-500" />
            <span className="text-sm text-muted-foreground">
              Downloading update… {status.percent != null ? `${status.percent}%` : ''}
            </span>
          </>
        )}

        {type === 'downloaded' && status?.type === 'downloaded' && (
          <>
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
            <span className="text-sm">
              Update ready — <span className="font-mono font-medium">v{status.version}</span>
            </span>
          </>
        )}

        {type === 'error' && status?.type === 'error' && (
          <>
            <AlertCircle className="size-4 shrink-0 text-destructive" />
            <span className="text-sm text-destructive">
              Update check failed{status.message ? `: ${status.message}` : ''}
            </span>
          </>
        )}

        {type == null && (
          <span className="text-sm text-muted-foreground">No update check performed yet</span>
        )}
      </div>

      {/* Download progress bar */}
      {type === 'downloading' && status?.type === 'downloading' && status.percent != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${Math.min(status.percent, 100)}%` }}
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {(type === null || type === 'not-available' || type === 'error') && (
          <Button variant="outline" size="sm" onClick={onCheckForUpdates}>
            <RefreshCw className="size-3.5 mr-1.5" />
            Check for Updates
          </Button>
        )}

        {type === 'available' && (
          <Button variant="outline" size="sm" onClick={onDownload}>
            <Download className="size-3.5 mr-1.5" />
            Download Update
          </Button>
        )}

        {type === 'downloaded' && (
          <Button variant="outline" size="sm" onClick={onInstall}>
            <RotateCcw className="size-3.5 mr-1.5" />
            Restart to Install
          </Button>
        )}
      </div>
    </div>
  )
}
