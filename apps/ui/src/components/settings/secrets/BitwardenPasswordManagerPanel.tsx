import { useEffect, useState } from 'react'
import {
  Download,
  KeyRound,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SettingsApiClient } from '../settings-api-client'
import {
  connectBitwardenPasswordManager,
  disconnectSecureSecretProvider,
  fetchBitwardenPasswordManagerSettings,
  installBitwardenPasswordManagerCli,
  lockBitwardenPasswordManager,
  replaceBitwardenPasswordManagerCollections,
  testSecureSecretProvider,
  updateBitwardenPasswordManagerCli,
  unlockBitwardenPasswordManager,
  type BitwardenPasswordManagerSettings,
  type SecureSecretProviderSummary,
} from '@/lib/secure-secrets-api'
import { SourceStatusBadge } from './secret-ui'

interface BitwardenPasswordManagerPanelProps {
  apiClient: SettingsApiClient
  provider: SecureSecretProviderSummary | undefined
  materialEntryAvailable: boolean
  onChanged: (message: string) => Promise<void>
  onError: (error: unknown) => void
}

export function BitwardenPasswordManagerPanel({
  apiClient,
  provider,
  materialEntryAvailable,
  onChanged,
  onError,
}: BitwardenPasswordManagerPanelProps) {
  const [settings, setSettings] = useState<BitwardenPasswordManagerSettings | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [masterPassword, setMasterPassword] = useState('')
  const [cliPath, setCliPath] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const providerId = provider?.providerId
  const providerStatus = provider?.status

  useEffect(() => {
    let cancelled = false
    if (!providerId) {
      setSettings(null)
      setSelectedIds(new Set())
      setCliPath('')
      return () => {
        cancelled = true
      }
    }
    void fetchBitwardenPasswordManagerSettings(apiClient, providerId)
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setSelectedIds(selectedCollectionIds(next))
        setCliPath(next.cli.configuredExecutablePath ?? '')
      })
      .catch((error) => {
        if (!cancelled && providerStatus === 'available') onError(error)
      })
    return () => {
      cancelled = true
    }
  }, [apiClient, onError, providerId, providerStatus])

  const connect = async () => {
    setBusy('connect')
    try {
      await connectBitwardenPasswordManager(apiClient)
      await onChanged('Bitwarden Password Manager added. Unlock it to choose collections.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async () => {
    if (!provider) return
    setBusy('test')
    try {
      const result = await testSecureSecretProvider(apiClient, provider.providerId)
      await onChanged(result.code === 'ok'
        ? 'Bitwarden Password Manager is ready.'
        : 'Bitwarden Password Manager still needs attention.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const unlock = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!provider || !masterPassword) return
    const passwordForSubmission = masterPassword
    setMasterPassword('')
    setBusy('unlock')
    try {
      const next = await unlockBitwardenPasswordManager(
        apiClient,
        provider.providerId,
        passwordForSubmission,
      )
      setSettings(next)
      setSelectedIds(selectedCollectionIds(next))
      setCliPath(next.cli.configuredExecutablePath ?? '')
      await onChanged('Bitwarden Password Manager unlocked.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const lock = async () => {
    if (!provider) return
    setBusy('lock')
    try {
      await lockBitwardenPasswordManager(apiClient, provider.providerId)
      setSettings(null)
      setSelectedIds(new Set())
      await onChanged('Bitwarden Password Manager locked.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const installCli = async () => {
    if (!provider) return
    setBusy('install-cli')
    try {
      const next = await installBitwardenPasswordManagerCli(
        apiClient,
        provider.providerId,
      )
      setSettings(next)
      setCliPath(next.cli.configuredExecutablePath ?? '')
      await onChanged('Bitwarden CLI installed. Sign in once with the command shown below.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const saveCliPath = async () => {
    if (!provider) return
    setBusy('cli-path')
    try {
      const next = await updateBitwardenPasswordManagerCli(
        apiClient,
        provider.providerId,
        cliPath.trim() || null,
      )
      setSettings(next)
      setCliPath(next.cli.configuredExecutablePath ?? '')
      await onChanged(cliPath.trim()
        ? 'Custom Bitwarden CLI path saved.'
        : 'Automatic Bitwarden CLI discovery restored.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const resetCliPath = async () => {
    if (!provider) return
    setBusy('cli-path')
    try {
      const next = await updateBitwardenPasswordManagerCli(
        apiClient,
        provider.providerId,
        null,
      )
      setSettings(next)
      setCliPath('')
      await onChanged('Automatic Bitwarden CLI discovery restored.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const saveCollections = async () => {
    if (!provider) return
    setBusy('collections')
    try {
      const result = await replaceBitwardenPasswordManagerCollections(
        apiClient,
        provider.providerId,
        [...selectedIds],
      )
      setSettings(result.settings)
      setSelectedIds(selectedCollectionIds(result.settings))
      await onChanged(
        `Bitwarden collections saved. ${result.addedSecrets} added, ${result.removedSecrets} removed.`,
      )
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    if (!provider) return
    const confirmed = typeof window === 'undefined' || window.confirm(
      'Disconnect Bitwarden Password Manager and remove its Forge catalog entries?',
    )
    if (!confirmed) return
    setBusy('disconnect')
    try {
      await disconnectSecureSecretProvider(apiClient, provider.providerId)
      await onChanged('Bitwarden Password Manager disconnected.')
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  if (!provider) {
    return (
      <div className="rounded-md border border-border/70 bg-card/40 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="rounded-md border border-border bg-background p-2">
              <ShieldCheck className="size-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Bitwarden Password Manager</p>
              <p className="text-xs text-muted-foreground">
                Use selected organization collections from the local Bitwarden CLI account.
                Forge keeps the vault session in memory and secret values outside chat.
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={busy !== null}
            onClick={() => void connect()}
          >
            {busy === 'connect'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <KeyRound className="size-3.5" />}
            Add source
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          After adding the source, Forge can install its own CLI copy. You will run
          {' '}<code>bw login</code> once for the dedicated Forge Bitwarden account.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/70 bg-card/40 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="rounded-md border border-border bg-background p-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="truncate text-sm font-medium">{provider.displayName}</p>
            <p className="text-xs text-muted-foreground">
              {settings?.accountEmail ?? 'Local Bitwarden CLI account'}
              {settings?.serverUrl ? ` · ${settings.serverUrl}` : ''}
            </p>
          </div>
        </div>
        <SourceStatusBadge status={provider.status} />
      </div>

      {settings ? (
        <div className="mt-3 rounded-md border border-border/70 bg-background/40 p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">Bitwarden CLI</p>
              {settings.cli.state === 'ready' ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Version {settings.cli.version} · {cliSourceLabel(settings.cli.source)}
                  </p>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">
                    {settings.cli.executablePath}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {settings.cli.state === 'unsupported'
                    ? 'Automatic installation is unavailable for this operating system or architecture.'
                    : 'No working Bitwarden CLI was found.'}
                </p>
              )}
            </div>
            {settings.cli.state !== 'ready' && settings.cli.canInstall ? (
              <Button
                type="button"
                size="sm"
                className="shrink-0 gap-1.5"
                disabled={busy !== null}
                onClick={() => void installCli()}
              >
                {busy === 'install-cli'
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Download className="size-3.5" />}
                Install CLI
              </Button>
            ) : null}
          </div>
          <details className="mt-3 border-t border-border/70 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Use another CLI installation
            </summary>
            <div className="mt-3 space-y-2">
              <Label htmlFor="bitwarden-password-manager-cli-path">
                Executable path
              </Label>
              <Input
                id="bitwarden-password-manager-cli-path"
                value={cliPath}
                onChange={(event) => setCliPath(event.target.value)}
                placeholder={settings.cli.executablePath ?? 'Full path to bw or bw.exe'}
                disabled={busy !== null}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void saveCliPath()}
                >
                  {busy === 'cli-path' ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Save path
                </Button>
                {settings.cli.configuredExecutablePath ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      setCliPath('')
                        void resetCliPath()
                    }}
                  >
                    Use automatic discovery
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Leave this empty to prefer Forge’s managed CLI, then a compatible CLI already
                installed on this computer.
              </p>
            </div>
          </details>
        </div>
      ) : null}

      {provider.status === 'auth_required' ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Bitwarden CLI is not logged in.
          </p>
          <p className="mt-1 text-muted-foreground">
            Run this once on this computer, then check again. Forge will handle later unlocks here.
          </p>
          <code className="mt-2 block select-all break-all rounded border border-border/70 bg-background/60 px-2 py-1.5 font-mono text-[11px] text-foreground">
            {bitwardenLoginCommand(settings?.cli.executablePath ?? null)}
          </code>
        </div>
      ) : null}

      {provider.status === 'unreachable' ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Bitwarden CLI is unavailable.
          </p>
          <p className="mt-1 text-muted-foreground">
            Install it above, or choose an existing <code>bw</code> executable under
            {' '}Use another CLI installation.
          </p>
        </div>
      ) : null}

      {provider.status === 'locked' ? (
        <form className="mt-3 space-y-3" onSubmit={unlock}>
          <div className="space-y-1.5">
            <Label htmlFor="bitwarden-password-manager-master-password">
              Bitwarden master password
            </Label>
            <Input
              id="bitwarden-password-manager-master-password"
              type="password"
              autoComplete="current-password"
              value={masterPassword}
              onChange={(event) => setMasterPassword(event.target.value)}
              placeholder="Unlock Bitwarden"
              disabled={!materialEntryAvailable || busy !== null}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Used once to unlock the local vault. It is cleared immediately and never saved.
          </p>
          <Button
            type="submit"
            size="sm"
            className="gap-1.5"
            disabled={!materialEntryAvailable || !masterPassword || busy !== null}
          >
            {busy === 'unlock'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <KeyRound className="size-3.5" />}
            Unlock
          </Button>
        </form>
      ) : null}

      {provider.status === 'available' && settings ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium">Collections available to Forge</p>
              <p className="text-xs text-muted-foreground">
                Selected collections are synchronized into Forge as metadata-only catalog entries.
                Access still requires a Secure Session grant.
              </p>
            </div>
            {settings.collections.length > 0 ? (
              <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <span className="mr-1">{selectedIds.size} selected</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={busy !== null || selectedIds.size === settings.collections.length}
                  onClick={() => setSelectedIds(new Set(
                    settings.collections.map((collection) => collection.collectionId),
                  ))}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={busy !== null || selectedIds.size === 0}
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
          {settings.collections.length === 0 ? (
            <p className="rounded-md border border-border/70 p-3 text-xs text-muted-foreground">
              This Bitwarden account has no accessible organization collections.
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border/70 p-2">
              {settings.collections.map((collection) => (
                <label
                  key={collection.collectionId}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted/60"
                >
                  <Checkbox
                    checked={selectedIds.has(collection.collectionId)}
                    onCheckedChange={(checked) => {
                      setSelectedIds((current) => {
                        const next = new Set(current)
                        if (checked === true) next.add(collection.collectionId)
                        else next.delete(collection.collectionId)
                        return next
                      })
                    }}
                    disabled={busy !== null}
                  />
                  <span className="min-w-0 truncate">{collection.name}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => void saveCollections()}
            >
              {busy === 'collections' ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save and sync
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy !== null}
              onClick={() => void testConnection()}
            >
              <RefreshCw className="size-3.5" />
              Sync status
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={busy !== null}
              onClick={() => void lock()}
            >
              <LockKeyhole className="size-3.5" />
              Lock
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-border/70 pt-3">
        {provider.status !== 'available' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busy !== null}
            onClick={() => void testConnection()}
          >
            {busy === 'test'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <RefreshCw className="size-3.5" />}
            Check again
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy !== null}
          onClick={() => void disconnect()}
        >
          {busy === 'disconnect'
            ? <Loader2 className="size-3.5 animate-spin" />
            : <Trash2 className="size-3.5" />}
          Disconnect
        </Button>
      </div>
    </div>
  )
}

function selectedCollectionIds(settings: BitwardenPasswordManagerSettings): Set<string> {
  return new Set(
    settings.collections
      .filter((collection) => collection.selected)
      .map((collection) => collection.collectionId),
  )
}

function cliSourceLabel(source: BitwardenPasswordManagerSettings['cli']['source']): string {
  switch (source) {
    case 'managed':
      return 'managed by Forge'
    case 'configured':
      return 'custom path'
    case 'system':
      return 'installed on this computer'
    default:
      return 'detected locally'
  }
}

function bitwardenLoginCommand(executablePath: string | null): string {
  if (!executablePath) return 'bw login'
  if (/\.exe$/iu.test(executablePath) || /^[A-Za-z]:[\\/]/u.test(executablePath)) {
    return `& "${executablePath.replaceAll('`', '``').replaceAll('"', '`"')}" login`
  }
  return `'${executablePath.replaceAll("'", "'\\''")}' login`
}
