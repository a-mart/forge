import { useCallback, useEffect, useState } from 'react'
import { Check, Laptop, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SettingsApiClient } from '../settings-api-client'
import {
  claimSecureBrowserPairing,
  createSecureBrowserPairingRequest,
  decideSecureBrowserPairing,
  fetchSecureBrowserControlStatus,
  fetchSecureBrowserSettings,
  revokeSecureBrowserDevice,
} from '@/lib/secure-browser-control-api'
import { SecureBrowserPairingDialog } from '@/components/chat/secure-session/SecureBrowserPairingDialog'
import type {
  SecureBrowserControlStatus,
  SecureBrowserSettingsSnapshot,
} from '@forge/protocol'

interface SecureBrowserAccessPanelProps {
  apiClient: SettingsApiClient
  status?: SecureBrowserControlStatus | null
  onAccessChanged?: () => void | Promise<void>
}

export function SecureBrowserAccessPanel({
  apiClient,
  status: statusProp,
  onAccessChanged,
}: SecureBrowserAccessPanelProps) {
  const desktopControlAvailable =
    typeof window !== 'undefined'
    && Boolean(window.electronBridge?.secureControlToken)
  const [snapshot, setSnapshot] = useState<SecureBrowserSettingsSnapshot | null>(
    null,
  )
  const [remoteStatus, setRemoteStatus] =
    useState<SecureBrowserControlStatus | null>(statusProp ?? null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pairingOpen, setPairingOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      if (desktopControlAvailable) {
        setSnapshot(await fetchSecureBrowserSettings(apiClient))
      } else {
        setRemoteStatus(await fetchSecureBrowserControlStatus(apiClient))
      }
    } catch {
      if (desktopControlAvailable) setSnapshot(null)
      else setRemoteStatus(null)
    } finally {
      setLoading(false)
    }
  }, [apiClient, desktopControlAvailable])

  useEffect(() => {
    if (statusProp !== undefined) setRemoteStatus(statusProp)
  }, [statusProp])

  useEffect(() => {
    void refresh()
    if (!desktopControlAvailable) return
    const timer = window.setInterval(() => void refresh(), 2_500)
    return () => window.clearInterval(timer)
  }, [desktopControlAvailable, refresh])

  const decide = async (requestId: string, decision: 'approve' | 'deny') => {
    if (busyId) return
    setBusyId(requestId)
    try {
      await decideSecureBrowserPairing(apiClient, requestId, decision)
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  const revoke = async (deviceId: string) => {
    if (busyId) return
    setBusyId(deviceId)
    try {
      await revokeSecureBrowserDevice(apiClient, deviceId)
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (typeof window === 'undefined') return null

  if (!desktopControlAvailable) {
    if (!loading && remoteStatus?.available !== true) return null
    return (
      <>
        <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
          <div>
            <h3 className="text-sm font-semibold">Secure browser access</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Pair this browser once with the running Forge Desktop instance.
              Approval is revocable and private values are encrypted in this
              browser before they cross the Builder backend.
            </p>
          </div>
          {loading && !remoteStatus ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Checking secure browser access…
            </div>
          ) : remoteStatus?.authorized ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="size-4" aria-hidden="true" />
              Paired as {remoteStatus.device?.deviceName ?? 'this browser'}
            </div>
          ) : remoteStatus?.secureContextRequired ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Open this Forge instance over HTTPS to pair secure browser access.
            </p>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => setPairingOpen(true)}
            >
              Pair this browser
            </Button>
          )}
        </section>
        {pairingOpen ? (
          <SecureBrowserPairingDialog
            onCreate={() => createSecureBrowserPairingRequest(apiClient)}
            onClaim={(requestId, claimSecret) =>
              claimSecureBrowserPairing(apiClient, requestId, claimSecret)}
            onPaired={async () => {
              await refresh()
              await onAccessChanged?.()
            }}
            onClose={() => setPairingOpen(false)}
          />
        ) : null}
      </>
    )
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Paired browsers</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Approve a remote browser once, then use Secure Sessions there
            without exposing the Desktop control capability.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Loading browser access…
        </div>
      ) : snapshot ? (
        <div className="space-y-3">
          {snapshot.pendingRequests.map((request) => (
            <div
              key={request.requestId}
              className="flex flex-col gap-3 rounded-md border border-amber-500/35 bg-amber-500/5 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium">{request.deviceName}</p>
                <p className="mt-1 font-mono text-lg tracking-[0.2em]">
                  {request.verificationCode.slice(0, 3)}{' '}
                  {request.verificationCode.slice(3)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void decide(request.requestId, 'approve')}
                  disabled={Boolean(busyId)}
                >
                  <Check className="size-3.5" aria-hidden="true" />
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void decide(request.requestId, 'deny')}
                  disabled={Boolean(busyId)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                  Deny
                </Button>
              </div>
            </div>
          ))}

          {snapshot.devices.filter((device) => !device.revokedAt).map((device) => (
            <div
              key={device.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{device.deviceName}</p>
                  <p className="text-xs text-muted-foreground">
                    {device.lastUsedAt
                      ? `Last used ${new Date(device.lastUsedAt).toLocaleString()}`
                      : `Paired ${new Date(device.createdAt).toLocaleString()}`}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void revoke(device.id)}
                disabled={Boolean(busyId)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Revoke
              </Button>
            </div>
          ))}

          {snapshot.pendingRequests.length === 0
            && snapshot.devices.every((device) => device.revokedAt) ? (
              <p className="text-xs text-muted-foreground">
                No browsers are paired. Start pairing from a secure request in
                the remote browser.
              </p>
            ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Paired browser access is unavailable in this Desktop session.
        </p>
      )}
    </section>
  )
}
