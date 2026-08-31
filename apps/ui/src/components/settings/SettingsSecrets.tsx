import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Database, Link2, Loader2, Server } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SettingsApiClient } from './settings-api-client'
import {
  checkSecureMaterialEntryAvailability,
  fetchSecureSecretsCatalog,
  fetchSecureSessionReadiness,
  installSecureRunner,
  isSecureMaterialEntryAvailable,
  resolveMaxProjectDefaults,
  secureSecretsErrorMessage,
  testSecureSecretProvider,
  unlockSecureMaterialEntry,
  updateSecureSecretSettings,
  type SecureSecretsCatalog,
  type SecureSessionReadiness,
} from '@/lib/secure-secrets-api'
import { fetchSecureBrowserControlStatus } from '@/lib/secure-browser-control-api'
import { SecretBindingsPanel } from './secrets/SecretBindingsPanel'
import { SecretCatalogPanel } from './secrets/SecretCatalogPanel'
import { SecretSourcesPanel } from './secrets/SecretSourcesPanel'
import { SecureSessionsReadinessPanel } from './secrets/SecureSessionsReadinessPanel'
import { SecureBrowserAccessPanel } from './secrets/SecureBrowserAccessPanel'
import { SshTrustedHostsPanel } from './secrets/SshTrustedHostsPanel'
import {
  SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MIN_PROJECT_DEFAULTS,
  parseMaxProjectDefaults,
  type ManagerProfile,
  type SecureBrowserControlStatus,
} from '@forge/protocol'

interface SettingsSecretsProps {
  apiClient: SettingsApiClient
  profiles: ManagerProfile[]
  currentProfileId?: string
}

export function SettingsSecrets({ apiClient, profiles, currentProfileId }: SettingsSecretsProps) {
  if (apiClient.target.kind !== 'builder') {
    return (
      <div className="rounded-md border border-border bg-card/40 p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Local Builder only</h2>
            <p className="text-sm text-muted-foreground">
              Secret sources and bindings are disabled for remote origins.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <BuilderSecretsSettings
      apiClient={apiClient}
      profiles={profiles}
      currentProfileId={currentProfileId}
    />
  )
}

function BuilderSecretsSettings({
  apiClient,
  profiles,
  currentProfileId,
}: SettingsSecretsProps) {
  const [catalog, setCatalog] = useState<SecureSecretsCatalog>({
    providers: [],
    secrets: [],
    projectDefaults: [],
    sshTrustedHosts: [],
    maxProjectDefaults: SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [materialEntryAvailable, setMaterialEntryAvailable] = useState(false)
  const [unlockingPrivateEntry, setUnlockingPrivateEntry] = useState(false)
  const [privateEntryUnlockMessage, setPrivateEntryUnlockMessage] =
    useState<string | null>(null)
  const [secureBrowserControl, setSecureBrowserControl] =
    useState<SecureBrowserControlStatus | null>(null)
  const localMaterialEntrySupported = isSecureMaterialEntryAvailable()
  const materialEntrySupported =
    localMaterialEntrySupported
    || secureBrowserControl?.privateEntryAvailable === true
  const [readiness, setReadiness] = useState<SecureSessionReadiness | null>(null)
  const [installingRunner, setInstallingRunner] = useState(false)
  const [runnerInstallMessage, setRunnerInstallMessage] = useState<string | null>(null)
  const [limitDraft, setLimitDraft] = useState(String(SECURE_SECRET_MAX_PROJECT_DEFAULTS))
  const [savingLimit, setSavingLimit] = useState(false)
  const maxProjectDefaults = resolveMaxProjectDefaults(catalog)
  const projectProfiles = useMemo(
    () => profiles.filter((profile) =>
      profile.profileType !== 'system' && !profile.archivedAt
    ),
    [profiles],
  )
  const initialProfileId = projectProfiles.some(
    (profile) => profile.profileId === currentProfileId,
  )
    ? currentProfileId
    : projectProfiles[0]?.profileId
  const contextualProfileId = projectProfiles.some(
    (profile) => profile.profileId === currentProfileId,
  )
    ? currentProfileId
    : undefined
  const projectProfileIds = useMemo(
    () => new Set(projectProfiles.map((profile) => profile.profileId)),
    [projectProfiles],
  )
  const visibleSecrets = useMemo(
    () => catalog.secrets.filter((secret) =>
      secret.scope.kind === 'instance'
      || (
        secret.scope.kind === 'profile'
          ? projectProfileIds.has(secret.scope.profileId)
          : secret.scope.profileIds.some((profileId) =>
              projectProfileIds.has(profileId)
            )
      )
    ),
    [catalog.secrets, projectProfileIds],
  )
  const visibleProjectDefaults = useMemo(
    () => catalog.projectDefaults.filter((projectDefault) =>
      projectProfileIds.has(projectDefault.profileId)
    ),
    [catalog.projectDefaults, projectProfileIds],
  )
  const visibleSshTrustedHosts = useMemo(
    () => (catalog.sshTrustedHosts ?? []).filter((host) =>
      projectProfileIds.has(host.profileId)
    ),
    [catalog.sshTrustedHosts, projectProfileIds],
  )
  const secretsReady =
    readiness?.available === true
    && materialEntryAvailable
    && catalog.providers.every((provider) => provider.status === 'available')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setRunnerInstallMessage(null)
    const [
      catalogResult,
      readinessResult,
      materialEntryResult,
      secureBrowserResult,
    ] =
      await Promise.allSettled([
        fetchSecureSecretsCatalog(apiClient),
        fetchSecureSessionReadiness(apiClient),
        checkSecureMaterialEntryAvailability(),
        fetchSecureBrowserControlStatus(apiClient),
      ])
    if (catalogResult.status === 'fulfilled') {
      const nextCatalog = catalogResult.value
      const nextLimit = resolveMaxProjectDefaults(nextCatalog)
      setCatalog({
        ...nextCatalog,
        projectDefaults: nextCatalog.projectDefaults ?? [],
        sshTrustedHosts: nextCatalog.sshTrustedHosts ?? [],
        maxProjectDefaults: nextLimit,
      })
      setLimitDraft(String(nextLimit))
    } else {
      setError(secureSecretsErrorMessage(catalogResult.reason))
    }
    setReadiness(readinessResult.status === 'fulfilled'
      ? readinessResult.value
      : { available: false, code: 'backend_unavailable' })
    const nextSecureBrowserControl =
      secureBrowserResult.status === 'fulfilled'
        ? secureBrowserResult.value
        : null
    setSecureBrowserControl(nextSecureBrowserControl)
    setMaterialEntryAvailable(
      (
        materialEntryResult.status === 'fulfilled'
        && materialEntryResult.value
      )
      || nextSecureBrowserControl?.privateEntryAvailable === true,
    )
    setLoading(false)
  }, [apiClient])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleChanged = useCallback(async (message: string) => {
    setNotice(message)
    await refresh()
  }, [refresh])

  const handleError = useCallback((nextError: unknown) => {
    setNotice(null)
    setError(secureSecretsErrorMessage(nextError))
  }, [])

  const handleUnlockPrivateEntry = useCallback(async () => {
    setUnlockingPrivateEntry(true)
    setPrivateEntryUnlockMessage(null)
    try {
      const unlocked = await unlockSecureMaterialEntry()
      if (!unlocked) {
        setPrivateEntryUnlockMessage(
          'Private storage is still locked. Unlock it in the system prompt, then try again.',
        )
        return
      }
      const localProvider = catalog.providers.find(
        (provider) => provider.kind === 'local_keychain' && provider.enabled,
      )
      if (!localProvider) {
        setPrivateEntryUnlockMessage('Private storage is unlocked.')
      } else {
        try {
          const result = await testSecureSecretProvider(
            apiClient,
            localProvider.providerId,
          )
          setPrivateEntryUnlockMessage(
            result.code === 'ok'
              ? 'Private storage is unlocked and the local vault is ready.'
              : result.code === 'local_secret_decrypt_failed'
                ? 'Private storage is unlocked, but some saved values need attention. Use Test vault below to recover them.'
                : 'Private storage is unlocked, but the local vault could not be verified. Use Test vault below to retry.',
          )
        } catch {
          setPrivateEntryUnlockMessage(
            'Private storage is unlocked, but the local vault could not be verified. Use Test vault below to retry.',
          )
        }
      }
      await refresh()
    } finally {
      setUnlockingPrivateEntry(false)
    }
  }, [apiClient, catalog.providers, refresh])

  const handleInstallRunner = useCallback(async () => {
    setInstallingRunner(true)
    setRunnerInstallMessage(null)
    setError(null)
    try {
      const result = await installSecureRunner(apiClient)
      setReadiness(result)
      setRunnerInstallMessage(
        result.available
          ? 'Secure runner installed. Secure Bash is ready.'
          : result.code === 'backend_unavailable'
            ? 'Docker became unavailable. Start Docker Desktop and try again.'
            : 'The secure runner could not be installed. Check Docker storage and network access, then try again.',
      )
    } catch (nextError) {
      setRunnerInstallMessage(secureSecretsErrorMessage(nextError))
    } finally {
      setInstallingRunner(false)
    }
  }, [apiClient])

  const handleSaveLimit = useCallback(async () => {
    let parsed: number
    try {
      parsed = parseMaxProjectDefaults(Number(limitDraft))
    } catch {
      setError(
        `Enter a whole number from ${SECURE_SECRET_MIN_PROJECT_DEFAULTS} to ${SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS}.`,
      )
      return
    }
    setSavingLimit(true)
    setError(null)
    try {
      const result = await updateSecureSecretSettings(apiClient, {
        maxProjectDefaults: parsed,
      })
      setCatalog((current) => ({
        ...current,
        maxProjectDefaults: result.settings.maxProjectDefaults,
      }))
      setLimitDraft(String(result.settings.maxProjectDefaults))
      setNotice('Secure-grant limit saved.')
    } catch (nextError) {
      setError(secureSecretsErrorMessage(nextError))
    } finally {
      setSavingLimit(false)
    }
  }, [apiClient, limitDraft])

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Secrets</h2>
        <p className="text-sm text-muted-foreground">
          Save private values or external references. Forge creates a safe default delivery
          automatically. Catalog availability does not grant access; choose projects under
          Automatically grant in only when access should begin with Team Secure Mode.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="rounded-md border border-border/70 bg-card/30 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <Label htmlFor="max-project-defaults" className="text-sm font-medium">
              Secure grants per project
            </Label>
            <p className="text-xs text-muted-foreground">
              Each project can grant at most this many saved secrets automatically or in one manual request. Default is {SECURE_SECRET_MAX_PROJECT_DEFAULTS}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="max-project-defaults"
              type="number"
              min={SECURE_SECRET_MIN_PROJECT_DEFAULTS}
              max={SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS}
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
              className="w-24"
              aria-label="Secure grants per project"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => { void handleSaveLimit() }}
              disabled={savingLimit || limitDraft === String(maxProjectDefaults)}
            >
              {savingLimit ? <Loader2 className="size-3.5 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      {notice ? (
        <div
          role="status"
          className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {notice}
        </div>
      ) : null}

      <SecureSessionsReadinessPanel
        readiness={readiness}
        loading={loading}
        privateEntrySupported={materialEntrySupported}
        privateEntryAvailable={materialEntryAvailable}
        unlockingPrivateEntry={unlockingPrivateEntry}
        privateEntryUnlockMessage={privateEntryUnlockMessage}
        installingRunner={installingRunner}
        runnerInstallMessage={runnerInstallMessage}
        providers={catalog.providers}
        maxProjectDefaults={maxProjectDefaults}
        configuredProjectDefaultCount={contextualProfileId
          ? new Set([
              ...catalog.projectDefaults
                .filter((projectDefault) =>
                  projectDefault.profileId === contextualProfileId
                )
                .map((projectDefault) => projectDefault.secretId),
              ...catalog.secrets
                .filter((secret) =>
                  secret.automaticGrantPolicy?.kind === 'all_projects'
                  || (
                    secret.automaticGrantPolicy?.kind === 'projects'
                    && secret.automaticGrantPolicy.profileIds.includes(contextualProfileId)
                  )
                )
                .map((secret) => secret.secretId),
            ]).size
          : undefined}
        onRefresh={refresh}
        onUnlockPrivateEntry={handleUnlockPrivateEntry}
        onInstallRunner={handleInstallRunner}
      />

      <SecureBrowserAccessPanel
        apiClient={apiClient}
        status={secureBrowserControl}
        onAccessChanged={refresh}
      />

      {loading && catalog.providers.length === 0 && catalog.secrets.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading secure sources…
        </div>
      ) : (
        <Tabs
          defaultValue={
            secretsReady ? 'secrets' : 'sources'
          }
          className="gap-5"
        >
          <TabsList aria-label="Secret settings sections">
            <TabsTrigger value="sources" className="gap-1.5">
              <Database className="size-3.5" />
              Sources
            </TabsTrigger>
            <TabsTrigger value="secrets">Secrets</TabsTrigger>
            <TabsTrigger value="bindings" className="gap-1.5">
              <Link2 className="size-3.5" />
              Advanced delivery
            </TabsTrigger>
            <TabsTrigger value="ssh-hosts" className="gap-1.5">
              <Server className="size-3.5" />
              SSH hosts
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sources">
            <SecretSourcesPanel
              apiClient={apiClient}
              providers={catalog.providers}
              materialEntrySupported={materialEntrySupported}
              materialEntryAvailable={materialEntryAvailable}
              vaultTransferSupported={localMaterialEntrySupported}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
          <TabsContent value="secrets">
            <SecretCatalogPanel
              apiClient={apiClient}
              providers={catalog.providers}
              secrets={visibleSecrets}
              projectDefaults={visibleProjectDefaults}
              profiles={projectProfiles}
              initialProfileId={initialProfileId}
              materialEntryAvailable={materialEntryAvailable}
              maxProjectDefaults={maxProjectDefaults}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
          <TabsContent value="bindings">
            <SecretBindingsPanel
              apiClient={apiClient}
              secrets={visibleSecrets}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
          <TabsContent value="ssh-hosts">
            <SshTrustedHostsPanel
              apiClient={apiClient}
              trustedHosts={visibleSshTrustedHosts}
              profiles={projectProfiles}
              initialProfileId={initialProfileId}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
