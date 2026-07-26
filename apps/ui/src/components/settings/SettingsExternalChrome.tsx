import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type {
  ExternalChromeBuildInventory,
  ExternalChromeCoordinatorStatus,
} from '@forge/protocol'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SettingsSection } from './settings-row'

const EXTENSION_ID = 'fcchfcnadajoejfbiclihglkmbcfhajd'

const CONFIRMATIONS = {
  enable: {
    title: 'Enable External Chrome?',
    description: 'Enable only after you verify the unpacked folder, pinned extension ID, and a dedicated Chrome profile. This starts the local coordinator and native host for this Forge data directory; it does not attach any tab. The Local Beta extension declares broad Chrome permissions; see Permissions & diagnostics for the declared set versus current behavior.',
    action: 'Enable',
  },
  disable: {
    title: 'Disable External Chrome?',
    description: 'This stops the local coordinator and disconnects the native host. Chrome keeps the manually loaded extension in each profile.',
    action: 'Disable',
  },
  repair: {
    title: 'Repair the native host?',
    description: 'Forge will repair its native-messaging registration and may rotate local authentication. It will not inspect or change Chrome profiles or tabs.',
    action: 'Repair',
  },
  rollback: {
    title: 'Roll back External Chrome?',
    description: 'Forge will select the last validated payload and native host. Compatible connected profiles auto-reload afterward; reload manually in chrome://extensions only when status shows Manual extension reload required.',
    action: 'Roll back',
  },
  remove: {
    title: 'Remove the native integration?',
    description: 'Forge will disable the coordinator, unregister its native host, and remove local authentication. Remove the unpacked extension manually from each Chrome profile. Detach leaves user tabs open.',
    action: 'Remove integration',
  },
  takeover: {
    title: 'Take over stale Forge ownership?',
    description: 'This transfers stale Forge coordinator and native-host ownership for this data directory only when the prior Forge authority is quiesced/non-live and exact durable registration authorization is present. It rotates local authentication, restores the authenticated listener, and preserves any local durable checkpoint for exact-instance reconnect/reconciliation and later lifecycle release. It never takes over or attaches Chrome profiles or tabs.',
    action: 'Confirm takeover',
  },
} as const

type ConfirmedAction = keyof typeof CONFIRMATIONS
type CopyTarget = 'path' | 'id'
type Disclosure = 'setup' | 'advanced'

export function SettingsExternalChrome() {
  const bridge = typeof window === 'undefined' ? undefined : window.electronBridge?.externalChrome
  const [status, setStatus] = useState<ExternalChromeCoordinatorStatus | null>(null)
  const [loading, setLoading] = useState(Boolean(bridge))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null)
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [openDisclosure, setOpenDisclosure] = useState<Disclosure | null>(null)

  const load = useCallback(async () => {
    if (!bridge) return
    setLoading(true)
    setError(null)
    try {
      const result = await bridge.status()
      if (!result.ok) throw new Error('status')
      setStatus(result.status)
    } catch {
      setError('External Chrome status is unavailable. Restart Forge Desktop and try again.')
    } finally {
      setLoading(false)
    }
  }, [bridge])

  useEffect(() => { void load() }, [load])

  const run = useCallback(async (action: 'enable' | 'disable' | 'repair' | 'rollback' | 'remove' | 'takeover' | 'revealExtensionFolder') => {
    if (!bridge) return
    setBusy(action)
    setError(null)
    try {
      const result = await bridge[action]()
      if (!result.ok) throw new Error(result.error)
      setStatus(result.status)
    } catch {
      setError('The requested External Chrome action could not be completed. Refresh status before trying again.')
    } finally {
      setBusy(null)
    }
  }, [bridge])

  async function copy(value: string, target: CopyTarget): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(value)
      setCopied(target)
      window.setTimeout(() => setCopied((current) => current === target ? null : current), 1_500)
    } catch {
      setError('Clipboard access is unavailable. Select and copy the value manually.')
    }
  }

  const setup = status?.setup
  const loadPath = setup?.pathState === 'ready' ? setup.loadUnpackedPath : undefined
  const confirmation = confirming ? CONFIRMATIONS[confirming] : null
  const pathReady = setup?.pathState === 'ready'

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        label="External Chrome (Local Beta)"
        description="Local-only unpacked Chrome extension and native host for this Forge data directory. Load the folder below in each Chrome profile you use."
        cta={bridge ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading || busy !== null}>
            <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        ) : undefined}
      >
        {!bridge ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            External Chrome setup and repair are available only in the main Forge Desktop window. No browser or Chrome profile was changed.
          </div>
        ) : loading && !status ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Loading local status…</div>
        ) : status ? (
          <>
            <FolderCard
              pathReady={Boolean(pathReady)}
              pathState={setup?.pathState}
              loadPath={loadPath}
              extensionId={setup?.extensionId}
              canReveal={status.canReveal}
              busy={busy !== null}
              copied={copied}
              onReveal={() => void run('revealExtensionFolder')}
              onCopyPath={(value) => void copy(value, 'path')}
              onCopyId={(value) => void copy(value, 'id')}
            />

            <StatusAndActions
              status={status}
              deploymentReady={Boolean(pathReady)}
              busy={busy}
              onConfirm={setConfirming}
            />

            <Disclosure
              id="setup"
              label="Chrome setup steps"
              open={openDisclosure === 'setup'}
              onToggle={() => setOpenDisclosure((current) => current === 'setup' ? null : 'setup')}
            >
              <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
                <li>Open a dedicated Chrome profile (Chrome 125+). Prefer only the accounts needed for Forge work.</li>
                <li>Open <code className="select-all rounded bg-muted px-1 py-0.5 text-foreground">chrome://extensions</code>, turn on <strong className="text-foreground">Developer mode</strong>, then <strong className="text-foreground">Load unpacked</strong> and choose the exact folder above.</li>
                <li>Confirm extension ID <code className="select-all break-all text-foreground">{EXTENSION_ID}</code>. If it differs, remove that extension and do not enable.</li>
                <li>Return here and enable the coordinator. Compatible connected profiles auto-reload after update or rollback; use manual Reload only when status shows Manual extension reload required.</li>
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">
                Forge does not open chrome:// pages or install the extension for you. Setup is per Chrome profile and per Forge data directory. Removing the native integration does not remove the unpacked extension from Chrome profiles. Detach leaves user tabs open.
              </p>
            </Disclosure>

            <Disclosure
              id="advanced"
              label="Permissions & diagnostics"
              open={openDisclosure === 'advanced'}
              onToggle={() => setOpenDisclosure((current) => current === 'advanced' ? null : 'advanced')}
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Unpacked Local Beta — not from the Chrome Web Store. External Chrome requests a broad declared V1 permission set: all websites plus debugger, history, bookmarks, downloads, top-sites, tabs, sessions, navigation, scripting, storage, tab-group, notification, side-panel, and native-messaging, plus optional authority to open downloaded files. Current Local Beta code does not read history, bookmarks, or top sites or open downloaded files; the startup shell registers download-change notifications but the payload ignores them, and Forge provides no managed download workflow or saved download artifacts. Forge does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. Leased-tab page content, accessibility data, diagnostics, snapshots, arbitrary JavaScript, and authenticated actions can still be exposed during agent turns.
                </p>

                <StatusSummary status={status} />
                <BuildStatus status={status} />

                <div className="space-y-2">
                  <p className="text-sm font-semibold">Advanced actions</p>
                  <p className="text-xs text-muted-foreground">
                    These manage Forge-owned deployment and registration for this data directory only. They do not attach tabs or change Chrome profiles.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirming('rollback')} disabled={!status.canRollback || busy !== null}>Roll back</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirming('takeover')} disabled={!pathReady || !status.canTakeover || busy !== null}>Take over stale owner</Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => setConfirming('remove')} disabled={!status.canRemove || busy !== null}>Remove integration</Button>
                  </div>
                </div>
              </div>
            </Disclosure>
          </>
        ) : null}

        {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      </SettingsSection>

      <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open) setConfirming(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy !== null}
              onClick={() => {
                const action = confirming
                setConfirming(null)
                if (action) void run(action)
              }}
            >
              {confirmation?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function FolderCard({
  pathReady,
  pathState,
  loadPath,
  extensionId,
  canReveal,
  busy,
  copied,
  onReveal,
  onCopyPath,
  onCopyId,
}: {
  pathReady: boolean
  pathState?: ExternalChromeCoordinatorStatus['setup']['pathState']
  loadPath?: string
  extensionId?: string
  canReveal: boolean
  busy: boolean
  copied: CopyTarget | null
  onReveal: () => void
  onCopyPath: (value: string) => void
  onCopyId: (value: string) => void
}) {
  return (
    <div className="space-y-3 rounded-md border border-border/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{pathReady ? 'Load unpacked folder' : 'Load unpacked folder not ready'}</p>
          <p className="text-xs text-muted-foreground">
            {pathReady
              ? 'Copy or reveal this exact Forge-managed folder in Chrome → Load unpacked.'
              : 'Forge could not validate the deployment path. Reveal and enable stay disabled.'}
          </p>
        </div>
        <Badge variant={pathReady ? 'default' : 'destructive'}>{pathState ?? 'unavailable'}</Badge>
      </div>
      {loadPath ? (
        <div className="flex flex-wrap gap-2">
          <code data-testid="external-chrome-load-path" className="min-w-0 flex-1 select-all break-all rounded bg-muted px-3 py-2 text-xs">{loadPath}</code>
          <Button type="button" variant="outline" size="sm" onClick={onReveal} disabled={!canReveal || busy}>
            <FolderOpen className="mr-1.5 size-3.5" />Reveal folder
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onCopyPath(loadPath)}>
            {copied === 'path' ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}Copy path
          </Button>
        </div>
      ) : (
        <p className="text-sm text-destructive">Deployment failed integrity, identity, compatibility, or path validation.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Extension ID</span>
        <code data-testid="external-chrome-extension-id" className="min-w-0 flex-1 select-all break-all rounded bg-muted px-2 py-1 text-xs">{extensionId ?? '—'}</code>
        <Button type="button" variant="ghost" size="sm" onClick={() => extensionId && onCopyId(extensionId)} disabled={!extensionId}>
          {copied === 'id' ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}Copy ID
        </Button>
      </div>
    </div>
  )
}

function StatusAndActions({
  status,
  deploymentReady,
  busy,
  onConfirm,
}: {
  status: ExternalChromeCoordinatorStatus
  deploymentReady: boolean
  busy: string | null
  onConfirm: (action: ConfirmedAction) => void
}) {
  const unavailable = busy !== null
  const recoveryMessage = recoveryGuidance(status.recovery)

  return (
    <div className="space-y-3 rounded-md border border-border/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">Connection</p>
          <p className="text-sm">
            <span className="font-medium">{status.state}</span>
            <span className="text-muted-foreground"> · {nativeStatusMessage(status)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Ownership {status.authority} · Auth {status.auth}
            {status.detail ? ` · ${status.detail}` : ''}
          </p>
          {status.recovery !== 'ready' ? (
            <p data-testid="external-chrome-recovery" className="text-xs text-amber-700 dark:text-amber-400">
              {status.recovery}: {recoveryMessage}
            </p>
          ) : (
            <p data-testid="external-chrome-recovery" className="sr-only">{status.recovery}: {recoveryMessage}</p>
          )}
          {status.state === 'other-instance' ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Another live Forge Desktop instance owns the coordinator and native host. Quiesce it before confirming takeover of that Forge ownership; this does not take over Chrome profiles or tabs.
              {status.ownerDataDirHash ? ` Owner data-dir hash: ${status.ownerDataDirHash}` : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => onConfirm('enable')} disabled={!deploymentReady || !status.canEnable || unavailable}>
            Enable
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onConfirm('disable')} disabled={!status.canDisable || unavailable}>
            Disable
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onConfirm('repair')} disabled={!status.canRepair || unavailable}>
            Repair native host
          </Button>
        </div>
      </div>
    </div>
  )
}

function Disclosure({
  id,
  label,
  open,
  onToggle,
  children,
}: {
  id: string
  label: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        data-testid={`external-chrome-disclosure-${id}`}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground"
        onClick={onToggle}
      >
        <span className="font-medium">{label}</span>
        {open ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
      </button>
      {open ? <div className="border-t border-border/60 px-3 py-3">{children}</div> : null}
    </div>
  )
}

function StatusSummary({ status }: { status: ExternalChromeCoordinatorStatus }) {
  return (
    <div className="grid gap-3 rounded-md border border-border/60 bg-muted/20 p-3 sm:grid-cols-2">
      <StatusItem label="Coordinator" value={status.state} />
      <StatusItem label="Desktop ownership" value={status.authority} />
      <StatusItem label="Native host" value={nativeStatusMessage(status)} />
      <StatusItem label="Local authentication" value={status.auth} />
      <StatusItem label="Recovery" value={status.recovery} />
    </div>
  )
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="text-sm font-medium">{value}</p></div>
}

function nativeStatusMessage(status: ExternalChromeCoordinatorStatus): string {
  if (status.trust === 'missing') return status.canRepair ? 'missing — repair available' : 'missing — reinstall Forge Desktop'
  if (status.trust === 'untrusted') return status.canRepair ? 'untrusted — repair available' : 'untrusted — repair blocked'
  if (status.registration === 'conflict') return 'foreign registration conflict'
  if (status.registration === 'needs-repair') return 'stale / needs repair'
  if (status.registration === 'not-registered') return 'not registered'
  return `${status.registration} · ${status.trust}`
}

function recoveryGuidance(recovery: ExternalChromeCoordinatorStatus['recovery']): string {
  const messages: Record<ExternalChromeCoordinatorStatus['recovery'], string> = {
    ready: 'External Chrome payload identity is authenticated and ready.',
    updating: 'New claims and browser operations are paused.',
    reconnecting: 'Forge requires a new authenticated hello before re-enabling operations.',
    'rolled-back': 'Rolled back to the last verified compatible payload.',
    'manual-extension-reload': 'Open chrome://extensions and click Reload for Forge. Compatible connected profiles otherwise auto-reload after update or rollback.',
    'incompatible-payload': 'The current and previous payloads are incompatible. External Chrome remains detached; Managed Browser is still available.',
    'authority-owned-by-other-data-dir': 'Another Forge data directory owns coordinator and native-host authority. Quiesce that authority, then confirm takeover. This does not transfer Chrome profiles or tabs.',
  }
  return messages[recovery]
}

function BuildStatus({ status }: { status: ExternalChromeCoordinatorStatus }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">Version inventory</p>
        <p className="text-xs text-muted-foreground">SHA-256 values appear when Forge has validated metadata. Running Chrome versions are not guessed before an authenticated connection.</p>
      </div>
      <div className="space-y-3">
        <Inventory label="Packaged with Desktop" value={status.setup.packaged} />
        <Inventory label="Deployed on disk" value={status.setup.deployed} />
        <Inventory label="Reported running" value={status.setup.running} empty="Not reported until an authenticated extension connection exists" />
      </div>
    </div>
  )
}

function Inventory({ label, value, empty = 'Unavailable' }: { label: string; value?: ExternalChromeBuildInventory; empty?: string }) {
  return (
    <div className="rounded border border-border/60 bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold">{label}</p>
      {!value ? <p className="text-xs text-muted-foreground">{empty}</p> : (
        <dl className="grid gap-2 text-xs">
          {value.desktopVersion ? <VersionRow label="Desktop" version={value.desktopVersion} /> : null}
          {value.packageVersion ? <VersionRow label="Package" version={value.packageVersion} /> : null}
          {value.shell ? <VersionRow label="Shell" version={value.shell.version ?? (value.shell.abi ? `ABI ${value.shell.abi}` : undefined)} hash={value.shell.sha256} /> : null}
          {value.payload ? <VersionRow label="Payload" version={value.payload.version} hash={value.payload.sha256} /> : null}
          {value.nativeHost ? <VersionRow label="Native host" version={value.nativeHost.version} hash={value.nativeHost.sha256} /> : null}
        </dl>
      )}
    </div>
  )
}

function VersionRow({ label, version, hash }: { label: string; version?: string; hash?: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        {version ? <span className="mr-2 font-medium">{version}</span> : null}
        {hash ? <code className="select-all break-all text-[10px] text-muted-foreground">sha256:{hash}</code> : null}
      </dd>
    </div>
  )
}
