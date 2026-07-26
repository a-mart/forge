import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Database, Link2, Loader2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { SettingsApiClient } from './settings-api-client'
import {
  checkSecureMaterialEntryAvailability,
  fetchSecureSecretsCatalog,
  fetchSecureSessionReadiness,
  isSecureMaterialEntryAvailable,
  secureSecretsErrorMessage,
  unlockSecureMaterialEntry,
  type SecureSecretsCatalog,
  type SecureSessionReadiness,
} from '@/lib/secure-secrets-api'
import { SecretBindingsPanel } from './secrets/SecretBindingsPanel'
import { SecretCatalogPanel } from './secrets/SecretCatalogPanel'
import { SecretSourcesPanel } from './secrets/SecretSourcesPanel'
import { SecureSessionsReadinessPanel } from './secrets/SecureSessionsReadinessPanel'
import type { ManagerProfile } from '@forge/protocol'

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
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [materialEntryAvailable, setMaterialEntryAvailable] = useState(false)
  const [unlockingPrivateEntry, setUnlockingPrivateEntry] = useState(false)
  const [privateEntryUnlockMessage, setPrivateEntryUnlockMessage] =
    useState<string | null>(null)
  const materialEntrySupported = isSecureMaterialEntryAvailable()
  const [readiness, setReadiness] = useState<SecureSessionReadiness | null>(null)
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

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [catalogResult, readinessResult, materialEntryResult] =
      await Promise.allSettled([
        fetchSecureSecretsCatalog(apiClient),
        fetchSecureSessionReadiness(apiClient),
        checkSecureMaterialEntryAvailability(),
      ])
    if (catalogResult.status === 'fulfilled') {
      const nextCatalog = catalogResult.value
      setCatalog({
        ...nextCatalog,
        projectDefaults: nextCatalog.projectDefaults ?? [],
      })
    } else {
      setError(secureSecretsErrorMessage(catalogResult.reason))
    }
    setReadiness(readinessResult.status === 'fulfilled'
      ? readinessResult.value
      : { available: false, code: 'backend_unavailable' })
    setMaterialEntryAvailable(
      materialEntryResult.status === 'fulfilled' && materialEntryResult.value,
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
      setPrivateEntryUnlockMessage('Private storage is unlocked.')
      await refresh()
    } finally {
      setUnlockingPrivateEntry(false)
    }
  }, [refresh])

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
        providers={catalog.providers}
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
      />

      {loading && catalog.providers.length === 0 && catalog.secrets.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading secure sources…
        </div>
      ) : (
        <Tabs defaultValue="sources" className="gap-5">
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
          </TabsList>

          <TabsContent value="sources">
            <SecretSourcesPanel
              apiClient={apiClient}
              providers={catalog.providers}
              materialEntrySupported={materialEntrySupported}
              materialEntryAvailable={materialEntryAvailable}
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
        </Tabs>
      )}
    </div>
  )
}
