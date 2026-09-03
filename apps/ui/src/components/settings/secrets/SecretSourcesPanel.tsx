import { useMemo, useRef, useState } from 'react'
import {
  Database,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MaskedTextarea } from '@/components/secure-session/MaskedTextarea'
import type { SettingsApiClient } from '../settings-api-client'
import {
  connectBitwardenProvider,
  deleteSecureSecret,
  disconnectSecureSecretProvider,
  reconnectBitwardenProvider,
  testSecureSecretProvider,
  updateSecureSecret,
  type SecureSecretProviderTestResult,
  type SecureSecretProviderSummary,
  type SecureSecretSourceStatus,
} from '@/lib/secure-secrets-api'
import { SourceStatusBadge } from './secret-ui'
import { BitwardenPasswordManagerPanel } from './BitwardenPasswordManagerPanel'
import { VaultTransferPanel } from './VaultTransferPanel'

interface SecretSourcesPanelProps {
  apiClient: SettingsApiClient
  providers: SecureSecretProviderSummary[]
  materialEntrySupported: boolean
  materialEntryAvailable: boolean
  vaultTransferSupported: boolean
  onChanged: (message: string) => Promise<void>
  onError: (error: unknown) => void
}

export function SecretSourcesPanel({
  apiClient,
  providers,
  materialEntrySupported,
  materialEntryAvailable,
  vaultTransferSupported,
  onChanged,
  onError,
}: SecretSourcesPanelProps) {
  const [displayName, setDisplayName] = useState('Bitwarden Secrets Manager')
  const [serverOrigin, setServerOrigin] = useState('https://api.bitwarden.com')
  const [organizationId, setOrganizationId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [reconnectProviderId, setReconnectProviderId] = useState<string | null>(null)
  const [reconnectToken, setReconnectToken] = useState('')
  const [recovery, setRecovery] = useState<{
    providerId: string
    affectedSecrets: SecureSecretProviderTestResult['affectedSecrets']
    index: number
  } | null>(null)
  const [recoveryStarted, setRecoveryStarted] = useState(false)
  const [recoveryValue, setRecoveryValue] = useState('')
  const recoveryHadSkipRef = useRef(false)

  const localProvider = useMemo(
    () => providers.find((provider) => provider.kind === 'local_keychain'),
    [providers],
  )
  const bitwardenProviders = useMemo(
    () => providers.filter((provider) => provider.kind === 'bitwarden_secrets_manager'),
    [providers],
  )
  const bitwardenPasswordManagerProvider = useMemo(
    () => providers.find((provider) => provider.kind === 'bitwarden_password_manager'),
    [providers],
  )
  const localStatus: SecureSecretSourceStatus = materialEntryAvailable
    ? localProvider?.status ?? 'available'
    : materialEntrySupported
      ? 'locked'
      : 'disabled'

  const connectBitwarden = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const tokenForSubmission = accessToken
    setAccessToken('')

    if (
      !displayName.trim()
      || !serverOrigin.trim()
      || !tokenForSubmission
    ) {
      onError(new Error('invalid'))
      return
    }

    setBusyKey('connect')
    try {
      await connectBitwardenProvider(apiClient, {
        displayName: displayName.trim(),
        serverOrigin: serverOrigin.trim(),
        ...(organizationId.trim() ? { organizationId: organizationId.trim() } : {}),
        ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
        accessToken: tokenForSubmission,
      })
      setOrganizationId('')
      setProjectId('')
      await onChanged('Bitwarden Secrets Manager connected.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const testProvider = async (providerId: string) => {
    setBusyKey(`test:${providerId}`)
    try {
      const result = await testSecureSecretProvider(apiClient, providerId)
      if (
        result.provider.kind === 'local_keychain'
        && result.code === 'local_secret_decrypt_failed'
        && result.affectedSecrets.length > 0
      ) {
        recoveryHadSkipRef.current = false
        setRecovery({
          providerId,
          affectedSecrets: result.affectedSecrets,
          index: 0,
        })
        setRecoveryStarted(false)
      } else if (result.provider.kind === 'local_keychain') {
        recoveryHadSkipRef.current = false
        setRecovery(null)
        setRecoveryStarted(false)
        setRecoveryValue('')
      }
      await onChanged(
        result.code === 'ok'
          ? 'Secret source connection succeeded.'
          : result.code === 'local_secret_decrypt_failed'
            ? 'Some saved local values must be re-entered on this machine.'
          : 'Secret source is not available.',
      )
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const reconnectProvider = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const providerId = reconnectProviderId
    const tokenForSubmission = reconnectToken
    setReconnectToken('')
    if (!providerId || !tokenForSubmission) {
      onError(new Error('invalid'))
      return
    }

    setBusyKey(`reconnect:${providerId}`)
    try {
      await reconnectBitwardenProvider(apiClient, providerId, tokenForSubmission)
      setReconnectProviderId(null)
      await onChanged('Bitwarden Secrets Manager reconnected.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const advanceRecovery = async (
    current: NonNullable<typeof recovery>,
    skipped = false,
  ) => {
    setRecoveryValue('')
    if (skipped) recoveryHadSkipRef.current = true
    if (current.index + 1 < current.affectedSecrets.length) {
      setRecovery({
        ...current,
        index: current.index + 1,
      })
      return
    }
    setRecovery(null)
    setRecoveryStarted(false)
    const hasSkipped = recoveryHadSkipRef.current
    recoveryHadSkipRef.current = false
    if (hasSkipped) {
      await onChanged('Recovery paused. Skipped local values remain unavailable.')
      return
    }
    await testProvider(current.providerId)
  }

  const reenterLocalValue = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!recovery) return
    const affectedSecret = recovery.affectedSecrets[recovery.index]
    const valueForSubmission = recoveryValue
    setRecoveryValue('')
    if (!affectedSecret || !valueForSubmission) {
      onError(new Error('invalid'))
      return
    }

    setBusyKey(`recover:${affectedSecret.secretId}`)
    try {
      await updateSecureSecret(apiClient, affectedSecret.secretId, {
        material: valueForSubmission,
      })
      await advanceRecovery(recovery)
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const deleteUnrecoverableLocalSecret = async () => {
    if (!recovery) return
    const affectedSecret = recovery.affectedSecrets[recovery.index]
    if (!affectedSecret) return
    const confirmed = typeof window === 'undefined' || window.confirm(
      `Delete "${affectedSecret.displayAlias}" and its saved configuration?`,
    )
    if (!confirmed) return

    setRecoveryValue('')
    setBusyKey(`recover:${affectedSecret.secretId}`)
    try {
      await deleteSecureSecret(apiClient, affectedSecret.secretId)
      await advanceRecovery(recovery)
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const disconnectProvider = async (providerId: string) => {
    const confirmed = typeof window === 'undefined' || window.confirm(
      'Disconnect this Bitwarden source? Saved Forge aliases that use it will become unavailable.',
    )
    if (!confirmed) return

    setBusyKey(`disconnect:${providerId}`)
    try {
      await disconnectSecureSecretProvider(apiClient, providerId)
      await onChanged('Bitwarden Secrets Manager disconnected.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">Private sources</h3>
          <p className="text-sm text-muted-foreground">
            Sources keep credential material outside chat, task state, and Settings responses.
          </p>
        </div>

        <div className="rounded-md border border-border/70 bg-card/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <div className="rounded-md border border-border bg-background p-2">
                <Database className="size-4 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {localProvider?.displayName ?? 'Local vault'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Values are sealed by the Forge desktop private API and stored in this operating
                  system&apos;s credential vault.
                </p>
              </div>
            </div>
            <SourceStatusBadge status={localStatus} />
          </div>
          {!materialEntryAvailable ? (
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-300">
              {materialEntrySupported
                ? 'Private storage is locked. Unlock it above to add, rotate, or test local values without restarting Forge.'
                : 'Secure operating-system storage is unavailable in this desktop session. Existing metadata remains readable, but private material cannot be added or rotated.'}
            </p>
          ) : null}
          {localProvider ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={busyKey !== null}
                onClick={() => void testProvider(localProvider.providerId)}
              >
                {busyKey === `test:${localProvider.providerId}`
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <PlugZap className="size-3.5" />}
                Test vault
              </Button>
            </div>
          ) : null}
          {recovery && recovery.providerId === localProvider?.providerId ? (
            <div className="mt-3 space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div>
                <p className="text-sm font-medium">Saved local values need attention</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {recovery.affectedSecrets.length} saved local
                  {' '}
                  {recovery.affectedSecrets.length === 1 ? 'value is' : 'values are'}
                  {' '}
                  unreadable here. Forge will handle one alias at a time.
                </p>
              </div>
              {!recoveryStarted ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={!materialEntryAvailable || busyKey !== null}
                  onClick={() => setRecoveryStarted(true)}
                >
                  Re-enter values on this machine
                </Button>
              ) : (
                <form className="space-y-3" onSubmit={reenterLocalValue}>
                <Field
                  label={`Private value for ${recovery.affectedSecrets[recovery.index]?.displayAlias ?? 'saved secret'}`}
                  htmlFor="local-secret-recovery-value"
                >
                  <MaskedTextarea
                    id="local-secret-recovery-value"
                    value={recoveryValue}
                    onValueChange={setRecoveryValue}
                    autoComplete="new-password"
                    placeholder="Re-enter value"
                    disabled={!materialEntryAvailable || busyKey !== null}
                    autoFocus
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {recovery.index + 1} of {recovery.affectedSecrets.length}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      !materialEntryAvailable
                      || busyKey !== null
                      || !recoveryValue
                    }
                  >
                    {busyKey?.startsWith('recover:')
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <KeyRound className="size-3.5" />}
                    Save and continue
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyKey !== null}
                    onClick={() => void advanceRecovery(recovery, true)}
                  >
                    Skip
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busyKey !== null}
                    onClick={() => void deleteUnrecoverableLocalSecret()}
                  >
                    Delete
                  </Button>
                </div>
                </form>
              )}
            </div>
          ) : null}
        </div>

        <BitwardenPasswordManagerPanel
          apiClient={apiClient}
          provider={bitwardenPasswordManagerProvider}
          materialEntryAvailable={materialEntryAvailable}
          onChanged={onChanged}
          onError={onError}
        />

        {vaultTransferSupported ? (
          <VaultTransferPanel
            apiClient={apiClient}
            available={materialEntryAvailable}
            onChanged={onChanged}
            onError={onError}
          />
        ) : null}

        {bitwardenProviders.map((provider) => (
          <div
            key={provider.providerId}
            className="rounded-md border border-border/70 bg-card/40 p-4"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <div className="rounded-md border border-border bg-background p-2">
                  <ShieldCheck className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">{provider.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    Bitwarden Secrets Manager
                  </p>
                </div>
              </div>
              <SourceStatusBadge status={provider.status} />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={busyKey !== null}
                onClick={() => void testProvider(provider.providerId)}
              >
                {busyKey === `test:${provider.providerId}`
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <PlugZap className="size-3.5" />}
                Test connection
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busyKey !== null}
                onClick={() => void disconnectProvider(provider.providerId)}
              >
                {busyKey === `disconnect:${provider.providerId}`
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Trash2 className="size-3.5" />}
                Disconnect
              </Button>
              {provider.status === 'auth_required' ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  disabled={busyKey !== null}
                  onClick={() => {
                    setReconnectToken('')
                    setReconnectProviderId(provider.providerId)
                  }}
                >
                  <KeyRound className="size-3.5" />
                  Reconnect
                </Button>
              ) : null}
            </div>
            {reconnectProviderId === provider.providerId ? (
              <form
                className="mt-3 space-y-3 rounded-md border border-amber-500/25 bg-amber-500/5 p-3"
                onSubmit={reconnectProvider}
              >
                <Field
                  label="New machine account access token"
                  htmlFor={`bitwarden-reconnect-token-${provider.providerId}`}
                >
                  <Input
                    id={`bitwarden-reconnect-token-${provider.providerId}`}
                    type="password"
                    value={reconnectToken}
                    onChange={(event) => setReconnectToken(event.target.value)}
                    autoComplete="new-password"
                    placeholder="Paste token"
                    disabled={!materialEntryAvailable || busyKey !== null}
                    autoFocus
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Only the credential changes. This connection and its saved secret references
                  stay in place.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      !materialEntryAvailable
                      || busyKey !== null
                      || !reconnectToken
                    }
                  >
                    {busyKey === `reconnect:${provider.providerId}`
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : <KeyRound className="size-3.5" />}
                    Save token
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyKey !== null}
                    onClick={() => {
                      setReconnectToken('')
                      setReconnectProviderId(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ))}
      </section>

      <section className="space-y-3 border-t border-border/70 pt-5">
        <div>
          <h3 className="text-base font-semibold">Connect Bitwarden Secrets Manager</h3>
          <p className="text-sm text-muted-foreground">
            The access token is encrypted by Forge Desktop before it is sent to the local Builder.
            It is never returned or shown again.
          </p>
        </div>

        <form className="space-y-4 rounded-md border border-border/70 p-4" onSubmit={connectBitwarden}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Connection name" htmlFor="bitwarden-display-name">
              <Input
                id="bitwarden-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Bitwarden work"
                disabled={!materialEntryAvailable || busyKey !== null}
              />
            </Field>
            <Field label="Server URL" htmlFor="bitwarden-server-origin">
              <Input
                id="bitwarden-server-origin"
                type="url"
                value={serverOrigin}
                onChange={(event) => setServerOrigin(event.target.value)}
                placeholder="https://api.bitwarden.com"
                disabled={!materialEntryAvailable || busyKey !== null}
              />
            </Field>
            <Field label="Organization ID (optional)" htmlFor="bitwarden-organization-id">
              <Input
                id="bitwarden-organization-id"
                value={organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
                disabled={!materialEntryAvailable || busyKey !== null}
              />
            </Field>
            <Field label="Project ID (optional)" htmlFor="bitwarden-project-id">
              <Input
                id="bitwarden-project-id"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                disabled={!materialEntryAvailable || busyKey !== null}
              />
            </Field>
          </div>

          <Field label="Machine account access token" htmlFor="bitwarden-access-token">
            <Input
              id="bitwarden-access-token"
              name="bitwardenAccessToken"
              type="password"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              autoComplete="new-password"
              placeholder="Paste token"
              disabled={!materialEntryAvailable || busyKey !== null}
            />
          </Field>

          <Button
            type="submit"
            size="sm"
            className="gap-1.5"
            disabled={!materialEntryAvailable || busyKey !== null || !accessToken}
          >
            {busyKey === 'connect'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <KeyRound className="size-3.5" />}
            Connect
          </Button>
        </form>
      </section>
    </div>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}
