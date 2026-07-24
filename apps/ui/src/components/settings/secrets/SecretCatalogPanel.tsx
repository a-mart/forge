import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Save,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SettingsApiClient } from '../settings-api-client'
import {
  SecureSecretsError,
  createLocalSecret,
  deleteSecureSecret,
  importBitwardenSecret,
  updateSecureSecret,
  type SecureSecretProviderSummary,
  type SecureSecretSummary,
} from '@/lib/secure-secrets-api'
import { EmptyState } from './secret-ui'
import { providerLabel } from './secret-ui-values'

interface SecretCatalogPanelProps {
  apiClient: SettingsApiClient
  providers: SecureSecretProviderSummary[]
  secrets: SecureSecretSummary[]
  materialEntryAvailable: boolean
  onChanged: (message: string) => Promise<void>
  onError: (error: unknown) => void
}

export function SecretCatalogPanel({
  apiClient,
  providers,
  secrets,
  materialEntryAvailable,
  onChanged,
  onError,
}: SecretCatalogPanelProps) {
  const [displayAlias, setDisplayAlias] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [material, setMaterial] = useState('')
  const [bitwardenProviderId, setBitwardenProviderId] = useState('')
  const [bitwardenLocator, setBitwardenLocator] = useState('')
  const [bitwardenAlias, setBitwardenAlias] = useState('')
  const [bitwardenName, setBitwardenName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editAlias, setEditAlias] = useState('')
  const [editName, setEditName] = useState('')
  const [replacementMaterial, setReplacementMaterial] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.providerId, provider])),
    [providers],
  )
  const bitwardenProviders = useMemo(
    () => providers.filter((provider) => provider.kind === 'bitwarden_secrets_manager'),
    [providers],
  )
  const selectedBitwardenProviderId = bitwardenProviders.some(
    (provider) => provider.providerId === bitwardenProviderId,
  )
    ? bitwardenProviderId
    : bitwardenProviders[0]?.providerId ?? ''

  const submitLocalSecret = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const materialForSubmission = material
    setMaterial('')

    if (!validAlias(displayAlias) || !materialForSubmission) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }

    setBusyKey('create')
    try {
      await createLocalSecret(apiClient, {
        displayAlias: displayAlias.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        material: materialForSubmission,
      })
      setDisplayAlias('')
      setDisplayName('')
      await onChanged('Local secret saved. No task has access until you grant it.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const submitBitwardenReference = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const sourceLocator = bitwardenLocator.trim()
    setBitwardenLocator('')
    if (
      !selectedBitwardenProviderId
      || !sourceLocator
      || !validAlias(bitwardenAlias)
    ) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }

    setBusyKey('import-bitwarden')
    try {
      await importBitwardenSecret(apiClient, {
        providerId: selectedBitwardenProviderId,
        sourceLocator,
        displayAlias: bitwardenAlias.trim(),
        ...(bitwardenName.trim() ? { displayName: bitwardenName.trim() } : {}),
      })
      setBitwardenAlias('')
      setBitwardenName('')
      await onChanged('Bitwarden secret reference imported. No task has access until you grant it.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const beginEdit = (secret: SecureSecretSummary) => {
    setEditingId(secret.secretId)
    setEditAlias(secret.displayAlias)
    setEditName(secret.displayName ?? '')
    setReplacementMaterial('')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditAlias('')
    setEditName('')
    setReplacementMaterial('')
  }

  const saveEdit = async (secret: SecureSecretSummary) => {
    const materialForSubmission = replacementMaterial
    setReplacementMaterial('')

    if (!validAlias(editAlias)) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }

    setBusyKey(`edit:${secret.secretId}`)
    try {
      await updateSecureSecret(apiClient, secret.secretId, {
        displayAlias: editAlias.trim(),
        displayName: editName.trim() || null,
        ...(materialForSubmission ? { material: materialForSubmission } : {}),
      })
      cancelEdit()
      await onChanged(
        materialForSubmission
          ? 'Secret metadata and private value updated.'
          : 'Secret metadata updated.',
      )
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const removeSecret = async (secret: SecureSecretSummary) => {
    const confirmed = typeof window === 'undefined' || window.confirm(
      `Delete "${secret.displayAlias}" and its saved bindings? Active task grants are managed separately.`,
    )
    if (!confirmed) return

    setBusyKey(`delete:${secret.secretId}`)
    try {
      await deleteSecureSecret(apiClient, secret.secretId)
      await onChanged('Saved secret deleted.')
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
          <h3 className="text-base font-semibold">Saved secrets</h3>
          <p className="text-sm text-muted-foreground">
            These entries identify stored sources. They are not active task grants and their values
            are never displayed.
          </p>
        </div>

        {secrets.length === 0 ? (
          <EmptyState
            title="No saved secrets"
            description="Add a local secret below or connect a source that supplies secret metadata."
          />
        ) : (
          <div className="space-y-2">
            {secrets.map((secret) => {
              const provider = providerById.get(secret.providerId)
              const isLocal = provider?.kind === 'local_keychain'
              const isEditing = editingId === secret.secretId
              const isBusy = busyKey?.endsWith(secret.secretId) ?? false

              return (
                <div
                  key={secret.secretId}
                  className="rounded-md border border-border/70 bg-card/40 p-4"
                >
                  {isEditing ? (
                    <div className="space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Alias" htmlFor={`edit-alias-${secret.secretId}`}>
                          <Input
                            id={`edit-alias-${secret.secretId}`}
                            value={editAlias}
                            onChange={(event) => setEditAlias(event.target.value)}
                            disabled={isBusy}
                          />
                        </Field>
                        <Field label="Display name" htmlFor={`edit-name-${secret.secretId}`}>
                          <Input
                            id={`edit-name-${secret.secretId}`}
                            value={editName}
                            onChange={(event) => setEditName(event.target.value)}
                            disabled={isBusy}
                          />
                        </Field>
                      </div>
                      {isLocal ? (
                        <Field
                          label="Replace private value (optional)"
                          htmlFor={`replace-material-${secret.secretId}`}
                        >
                          <Input
                            id={`replace-material-${secret.secretId}`}
                            type="password"
                            value={replacementMaterial}
                            onChange={(event) => setReplacementMaterial(event.target.value)}
                            autoComplete="new-password"
                            placeholder="Leave empty to keep the current value"
                            disabled={!materialEntryAvailable || isBusy}
                          />
                        </Field>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => void saveEdit(secret)}
                          disabled={isBusy}
                        >
                          {isBusy
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <Save className="size-3.5" />}
                          Save changes
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1.5"
                          onClick={cancelEdit}
                          disabled={isBusy}
                        >
                          <X className="size-3.5" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                          <p className="font-mono text-sm font-medium">{secret.displayAlias}</p>
                          {secret.available ? (
                            <Badge
                              variant="outline"
                              className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            >
                              <CheckCircle2 className="size-3" />
                              Available
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="gap-1 text-muted-foreground">
                              <ShieldOff className="size-3" />
                              Unavailable
                            </Badge>
                          )}
                        </div>
                        {secret.displayName ? (
                          <p className="text-sm text-muted-foreground">{secret.displayName}</p>
                        ) : null}
                        <p className="text-xs text-muted-foreground">
                          {providerLabel(secret.providerId, providers)}
                          {' · '}
                          {secret.bindings.length} saved binding
                          {secret.bindings.length === 1 ? '' : 's'}
                          {' · '}
                          Updated {formatDate(secret.updatedAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={busyKey !== null}
                          onClick={() => beginEdit(secret)}
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={busyKey !== null}
                          onClick={() => void removeSecret(secret)}
                        >
                          {busyKey === `delete:${secret.secretId}`
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <Trash2 className="size-3.5" />}
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {bitwardenProviders.length > 0 ? (
        <section className="space-y-3 border-t border-border/70 pt-5">
          <div>
            <h3 className="text-base font-semibold">Import Bitwarden secret reference</h3>
            <p className="text-sm text-muted-foreground">
              Save a Forge alias for a Bitwarden Secrets Manager ID. Forge stores the reference,
              never returns it in Settings responses, and resolves the value only for approved use.
            </p>
          </div>

          <form
            className="space-y-4 rounded-md border border-border/70 p-4"
            onSubmit={submitBitwardenReference}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bitwarden connection" htmlFor="bitwarden-reference-provider">
                <Select
                  value={selectedBitwardenProviderId}
                  onValueChange={setBitwardenProviderId}
                  disabled={busyKey !== null}
                >
                  <SelectTrigger id="bitwarden-reference-provider" className="w-full">
                    <SelectValue placeholder="Choose a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {bitwardenProviders.map((provider) => (
                      <SelectItem key={provider.providerId} value={provider.providerId}>
                        {provider.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Bitwarden secret ID" htmlFor="bitwarden-secret-locator">
                <Input
                  id="bitwarden-secret-locator"
                  value={bitwardenLocator}
                  onChange={(event) => setBitwardenLocator(event.target.value)}
                  placeholder="Secret UUID"
                  autoComplete="off"
                  disabled={busyKey !== null}
                  className="font-mono"
                />
              </Field>
              <Field label="Forge alias" htmlFor="bitwarden-secret-alias">
                <Input
                  id="bitwarden-secret-alias"
                  value={bitwardenAlias}
                  onChange={(event) => setBitwardenAlias(event.target.value)}
                  placeholder="database/production"
                  disabled={busyKey !== null}
                />
              </Field>
              <Field label="Display name (optional)" htmlFor="bitwarden-secret-display-name">
                <Input
                  id="bitwarden-secret-display-name"
                  value={bitwardenName}
                  onChange={(event) => setBitwardenName(event.target.value)}
                  placeholder="Production database password"
                  disabled={busyKey !== null}
                />
              </Field>
            </div>
            <Button
              type="submit"
              size="sm"
              className="gap-1.5"
              disabled={
                busyKey !== null
                || !selectedBitwardenProviderId
                || !bitwardenLocator.trim()
                || !validAlias(bitwardenAlias)
              }
            >
              {busyKey === 'import-bitwarden'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Plus className="size-3.5" />}
              Import reference
            </Button>
          </form>
        </section>
      ) : null}

      <section className="space-y-3 border-t border-border/70 pt-5">
        <div>
          <h3 className="text-base font-semibold">Add local secret</h3>
          <p className="text-sm text-muted-foreground">
            The private value is cleared from this form as soon as you submit it. Forge never shows
            a masked suffix or reveal control for saved values.
          </p>
        </div>

        <form className="space-y-4 rounded-md border border-border/70 p-4" onSubmit={submitLocalSecret}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Alias" htmlFor="local-secret-alias">
              <Input
                id="local-secret-alias"
                value={displayAlias}
                onChange={(event) => setDisplayAlias(event.target.value)}
                placeholder="github/work"
                disabled={!materialEntryAvailable || busyKey !== null}
              />
            </Field>
            <Field label="Display name (optional)" htmlFor="local-secret-display-name">
              <Input
                id="local-secret-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="GitHub work token"
                disabled={!materialEntryAvailable || busyKey !== null}
              />
            </Field>
          </div>
          <Field label="Private value" htmlFor="local-secret-material">
            <Input
              id="local-secret-material"
              name="localSecretMaterial"
              type="password"
              value={material}
              onChange={(event) => setMaterial(event.target.value)}
              autoComplete="new-password"
              placeholder="Paste value"
              disabled={!materialEntryAvailable || busyKey !== null}
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            className="gap-1.5"
            disabled={
              !materialEntryAvailable
              || busyKey !== null
              || !material
              || !validAlias(displayAlias)
            }
          >
            {busyKey === 'create'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <Plus className="size-3.5" />}
            Save local secret
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

function validAlias(value: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value.trim())
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleDateString()
}
