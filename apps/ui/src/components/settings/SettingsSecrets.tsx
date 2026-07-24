import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Database, Link2, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { SettingsApiClient } from './settings-api-client'
import {
  checkSecureMaterialEntryAvailability,
  fetchSecureSecretsCatalog,
  secureSecretsErrorMessage,
  type SecureSecretsCatalog,
} from '@/lib/secure-secrets-api'
import { SecretBindingsPanel } from './secrets/SecretBindingsPanel'
import { SecretCatalogPanel } from './secrets/SecretCatalogPanel'
import { SecretSourcesPanel } from './secrets/SecretSourcesPanel'

interface SettingsSecretsProps {
  apiClient: SettingsApiClient
}

export function SettingsSecrets({ apiClient }: SettingsSecretsProps) {
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

  return <BuilderSecretsSettings apiClient={apiClient} />
}

function BuilderSecretsSettings({ apiClient }: SettingsSecretsProps) {
  const [catalog, setCatalog] = useState<SecureSecretsCatalog>({
    providers: [],
    secrets: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [materialEntryAvailable, setMaterialEntryAvailable] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setCatalog(await fetchSecureSecretsCatalog(apiClient))
    } catch (loadError) {
      setError(secureSecretsErrorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [apiClient])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let current = true
    void checkSecureMaterialEntryAvailability().then((available) => {
      if (current) setMaterialEntryAvailable(available)
    })
    return () => {
      current = false
    }
  }, [])

  const handleChanged = useCallback(async (message: string) => {
    setNotice(message)
    await refresh()
  }, [refresh])

  const handleError = useCallback((nextError: unknown) => {
    setNotice(null)
    setError(secureSecretsErrorMessage(nextError))
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Secrets</h2>
          <p className="text-sm text-muted-foreground">
            Save private values or external references. Forge creates a safe default delivery
            automatically, but no task receives access until you grant it.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading
            ? <Loader2 className="size-3.5 animate-spin" />
            : <RefreshCw className="size-3.5" />}
          Refresh
        </Button>
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
              materialEntryAvailable={materialEntryAvailable}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
          <TabsContent value="secrets">
            <SecretCatalogPanel
              apiClient={apiClient}
              providers={catalog.providers}
              secrets={catalog.secrets}
              materialEntryAvailable={materialEntryAvailable}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
          <TabsContent value="bindings">
            <SecretBindingsPanel
              apiClient={apiClient}
              secrets={catalog.secrets}
              onChanged={handleChanged}
              onError={handleError}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
