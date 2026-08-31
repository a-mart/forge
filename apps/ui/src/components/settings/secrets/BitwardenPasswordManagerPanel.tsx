import { useEffect, useState } from 'react'
import { KeyRound, Loader2, LockKeyhole, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SettingsApiClient } from '../settings-api-client'
import {
  connectBitwardenPasswordManager,
  disconnectSecureSecretProvider,
  fetchBitwardenPasswordManagerSettings,
  lockBitwardenPasswordManager,
  replaceBitwardenPasswordManagerCollections,
  testSecureSecretProvider,
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
  const [busy, setBusy] = useState<string | null>(null)
  const providerId = provider?.providerId
  const providerStatus = provider?.status

  useEffect(() => {
    let cancelled = false
    if (!providerId) {
      setSettings(null)
      setSelectedIds(new Set())
      return () => {
        cancelled = true
      }
    }
    void fetchBitwardenPasswordManagerSettings(apiClient, providerId)
      .then((next) => {
        if (cancelled) return
        setSettings(next)
        setSelectedIds(selectedCollectionIds(next))
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
          One-time prerequisite: install the <code>bw</code> CLI and run <code>bw login</code>
          {' '}for the dedicated Forge Bitwarden account.
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

      {provider.status === 'auth_required' ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Bitwarden CLI is not logged in.
          </p>
          <p className="mt-1 text-muted-foreground">
            Run <code>bw login</code> once on this computer, then check again. Forge will handle
            later unlocks here.
          </p>
        </div>
      ) : null}

      {provider.status === 'unreachable' ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            Bitwarden CLI is unavailable.
          </p>
          <p className="mt-1 text-muted-foreground">
            Install <code>bw</code> and confirm <code>bw status</code> works from this computer,
            then check again.
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
