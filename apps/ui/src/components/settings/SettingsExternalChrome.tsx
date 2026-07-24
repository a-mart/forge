import { useCallback, useEffect, useState } from 'react'
import type {
  ExternalChromeBuildInventory,
  ExternalChromeCoordinatorStatus,
} from '@forge/protocol'
import {
  AlertTriangle,
  Check,
  Copy,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldAlert,
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
import type { ExternalChromeBridge } from '@/lib/electron-bridge'
import { SettingsSection } from './settings-row'

const CONFIRMATIONS = {
  enable: {
    title: 'Enable External Chrome?',
    description: 'Enable only after you verify the unpacked folder, pinned extension ID, broad Chrome permissions, and dedicated-profile recommendation. This starts the local coordinator and native host; it does not attach any tab.',
    action: 'Enable',
  },
  disable: {
    title: 'Disable External Chrome?',
    description: 'This stops the local coordinator and disconnects the native host. Chrome keeps the manually loaded extension.',
    action: 'Disable',
  },
  repair: {
    title: 'Repair the native host?',
    description: 'Forge will repair its native-messaging registration and may rotate local authentication. It will not inspect or change Chrome profiles.',
    action: 'Repair',
  },
  rollback: {
    title: 'Roll back External Chrome?',
    description: 'Forge will select the last validated payload and native host. Reload the unpacked extension manually in every Chrome profile afterward.',
    action: 'Roll back',
  },
  remove: {
    title: 'Remove the native integration?',
    description: 'Forge will disable the coordinator, unregister its native host, and remove local authentication. Remove the unpacked extension manually from each Chrome profile.',
    action: 'Remove integration',
  },
  takeover: {
    title: 'Take over stale ownership?',
    description: 'Use this only when the previous Forge Desktop instance is no longer running. Forge will rotate local authentication and claim the stale coordinator record.',
    action: 'Take over',
  },
} as const

type ConfirmedAction = keyof typeof CONFIRMATIONS
type CopyTarget = 'path' | 'id'

export function SettingsExternalChrome() {
  const bridge = typeof window === 'undefined' ? undefined : window.electronBridge?.externalChrome
  const [status, setStatus] = useState<ExternalChromeCoordinatorStatus | null>(null)
  const [loading, setLoading] = useState(Boolean(bridge))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null)
  const [copied, setCopied] = useState<CopyTarget | null>(null)

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

  const run = useCallback(async (action: keyof ExternalChromeBridge) => {
    if (!bridge || action === 'status') return
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

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="External Chrome (Local Beta)"
        description="One-time, local-only setup for Forge Desktop's unpacked Chrome extension and native host."
        cta={bridge ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading || busy !== null}>
            <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        ) : undefined}
      >
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-1">
              <p className="font-semibold">Unpacked extension — not from the Chrome Web Store</p>
              <p className="text-muted-foreground">
                This Local Beta is intentionally loaded from a Forge-managed folder. Chrome does not update it through the Web Store; after Forge updates, reload it manually in every Chrome profile where you loaded it.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="font-semibold">Powerful browser permissions</p>
              <p className="text-muted-foreground">
                External Chrome can access all websites and requests debugger, history, bookmarks, downloads, top-sites, tabs, sessions, navigation, scripting, storage, tab-group, notification, side-panel, and native-messaging permissions. It can expose page content, browsing activity, downloads, and authenticated actions. Use a dedicated Chrome profile with only the accounts needed for Forge work; do not start with your everyday profile.
              </p>
            </div>
          </div>
        </div>

        {!bridge ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            External Chrome setup and repair are available only in the main Forge Desktop window. No browser or Chrome profile was changed.
          </div>
        ) : loading && !status ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Loading local status…</div>
        ) : status ? (
          <>
            <StatusSummary status={status} />

            <div className="space-y-3 rounded-md border border-border/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{setup?.pathState === 'ready' ? 'Validated Load unpacked folder' : 'Load unpacked folder not ready'}</p>
                  <p className="text-xs text-muted-foreground">Resolved by Forge Desktop; this field cannot accept another path.</p>
                </div>
                <Badge variant={setup?.pathState === 'ready' ? 'default' : 'destructive'}>{setup?.pathState ?? 'unavailable'}</Badge>
              </div>
              {loadPath ? (
                <div className="flex flex-wrap gap-2">
                  <code data-testid="external-chrome-load-path" className="min-w-0 flex-1 select-all break-all rounded bg-muted px-3 py-2 text-xs">{loadPath}</code>
                  <Button type="button" variant="outline" size="sm" onClick={() => void run('revealExtensionFolder')} disabled={!status.canReveal || busy !== null}>
                    <FolderOpen className="mr-1.5 size-3.5" />Reveal folder
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copy(loadPath, 'path')}>
                    {copied === 'path' ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}Copy path
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-destructive">The deployment is missing or failed integrity, identity, compatibility, or path validation. Load, reveal, and enable actions stay disabled.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <code data-testid="external-chrome-extension-id" className="min-w-0 flex-1 select-all break-all rounded bg-muted px-3 py-2 text-xs">{setup?.extensionId}</code>
                <Button type="button" variant="outline" size="sm" onClick={() => setup?.extensionId && void copy(setup.extensionId, 'id')} disabled={!setup?.extensionId}>
                  {copied === 'id' ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}Copy ID
                </Button>
              </div>
            </div>

            <BuildStatus status={status} />
            <CoordinatorActions status={status} deploymentReady={setup?.pathState === 'ready'} busy={busy} onConfirm={setConfirming} />
          </>
        ) : null}

        {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      </SettingsSection>

      <SettingsSection label="Load it in each Chrome profile" description="Forge does not open chrome:// pages, enumerate profiles, or install the extension for you.">
        <ol className="list-decimal space-y-3 pl-5 text-sm text-muted-foreground">
          <li>Create or open the dedicated Chrome profile you intend to use. Extension loading is per Chrome profile, so repeat these steps separately for every profile.</li>
          <li>Manually enter <code className="select-all rounded bg-muted px-1 py-0.5 text-foreground">chrome://extensions</code> in Chrome.</li>
          <li>Turn on <strong className="text-foreground">Developer mode</strong> in the top-right corner.</li>
          <li>Click <strong className="text-foreground">Load unpacked</strong> and choose the exact validated folder shown above. Do not choose its parent or a payload subfolder.</li>
          <li>Confirm Chrome shows extension ID <code className="select-all break-all text-foreground">fcchfcnadajoejfbiclihglkmbcfhajd</code>. If the ID differs, remove that extension and do not enable the integration.</li>
          <li>After every Forge Desktop update, return to this page, compare the versions/hashes, then click <strong className="text-foreground">Reload</strong> on the extension card in each Chrome profile.</li>
        </ol>
        <p className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
          Removing or repairing the Forge native integration does not remove the unpacked extension from Chrome. Do that manually in each profile. Forge never scans Chrome profiles for this setup.
        </p>
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

function StatusSummary({ status }: { status: ExternalChromeCoordinatorStatus }) {
  const nativeMessage = nativeStatusMessage(status)
  return (
    <div className="grid gap-3 rounded-md border border-border/70 p-4 sm:grid-cols-2">
      <StatusItem label="Coordinator" value={status.state} />
      <StatusItem label="Desktop ownership" value={status.authority} />
      <StatusItem label="Native host" value={nativeMessage} />
      <StatusItem label="Local authentication" value={status.auth} />
      {status.detail ? <p className="sm:col-span-2 text-xs text-muted-foreground">{status.detail}</p> : null}
      {status.state === 'other-instance' ? <p className="sm:col-span-2 text-xs text-amber-600 dark:text-amber-400">Another live Forge Desktop instance owns the coordinator. Actions are disabled; close that instance first.</p> : null}
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

function CoordinatorActions({
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
  return (
    <div className="space-y-3 rounded-md border border-border/70 p-4">
      <div>
        <p className="text-sm font-semibold">Local coordinator actions</p>
        <p className="text-xs text-muted-foreground">These actions manage only Forge-owned deployment, authentication, and native registration. They do not attach tabs or change Chrome profiles.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => onConfirm('enable')} disabled={!deploymentReady || !status.canEnable || unavailable}>Enable</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onConfirm('disable')} disabled={!status.canDisable || unavailable}>Disable</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onConfirm('repair')} disabled={!status.canRepair || unavailable}>Repair native host</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onConfirm('rollback')} disabled={!status.canRollback || unavailable}>Roll back</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => onConfirm('takeover')} disabled={!deploymentReady || !status.canTakeover || unavailable}>Take over stale owner</Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => onConfirm('remove')} disabled={!status.canRemove || unavailable}>Remove integration</Button>
      </div>
    </div>
  )
}

function BuildStatus({ status }: { status: ExternalChromeCoordinatorStatus }) {
  return (
    <div className="space-y-3 rounded-md border border-border/70 p-4">
      <div>
        <p className="text-sm font-semibold">Version and integrity inventory</p>
        <p className="text-xs text-muted-foreground">Full SHA-256 values are shown when Forge has validated metadata. Running Chrome versions are intentionally not guessed before an authenticated runtime connection exists.</p>
      </div>
      <div className="space-y-3">
        <Inventory label="Packaged with Desktop" value={status.setup.packaged} />
        <Inventory label="Deployed on disk" value={status.setup.deployed} />
        <Inventory label="Reported running" value={status.setup.running} empty="Not reported in this setup milestone" />
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
