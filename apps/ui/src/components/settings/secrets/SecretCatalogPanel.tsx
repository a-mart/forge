import { useEffect, useMemo, useState } from 'react'
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
  updateSecureSecretProjectDefault,
  type SecureSecretProjectDefaultSummary,
  type SecureSecretProviderSummary,
  type SecureSecretScope,
  type SecureSecretSummary,
} from '@/lib/secure-secrets-api'
import { EmptyState } from './secret-ui'
import { providerLabel } from './secret-ui-values'
import {
  ProjectDefaultFields,
  SecretScopeFields,
} from './SecretProjectAccessFields'
import {
  projectName,
  scopeFor,
  scopeLabel,
  type SecretScopeKind,
} from './secret-project-access-values'
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  type ManagerProfile,
} from '@forge/protocol'

interface SecretCatalogPanelProps {
  apiClient: SettingsApiClient
  providers: SecureSecretProviderSummary[]
  secrets: SecureSecretSummary[]
  projectDefaults: SecureSecretProjectDefaultSummary[]
  profiles: ManagerProfile[]
  initialProfileId?: string
  materialEntryAvailable: boolean
  onChanged: (message: string) => Promise<void>
  onError: (error: unknown) => void
}

export function SecretCatalogPanel({
  apiClient,
  providers,
  secrets,
  projectDefaults,
  profiles,
  initialProfileId,
  materialEntryAvailable,
  onChanged,
  onError,
}: SecretCatalogPanelProps) {
  const firstProfileId = initialProfileId ?? profiles[0]?.profileId ?? ''
  const [displayAlias, setDisplayAlias] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [material, setMaterial] = useState('')
  const [localScopeKind, setLocalScopeKind] = useState<SecretScopeKind>(
    profiles.length > 0 ? 'profile' : 'instance',
  )
  const [localProfileId, setLocalProfileId] = useState(firstProfileId)
  const [localDefaultEnabled, setLocalDefaultEnabled] = useState(false)
  const [localDefaultProfileId, setLocalDefaultProfileId] = useState(firstProfileId)
  const [bitwardenProviderId, setBitwardenProviderId] = useState('')
  const [bitwardenLocator, setBitwardenLocator] = useState('')
  const [bitwardenAlias, setBitwardenAlias] = useState('')
  const [bitwardenName, setBitwardenName] = useState('')
  const [bitwardenScopeKind, setBitwardenScopeKind] = useState<SecretScopeKind>(
    profiles.length > 0 ? 'profile' : 'instance',
  )
  const [bitwardenProfileId, setBitwardenProfileId] = useState(firstProfileId)
  const [bitwardenDefaultEnabled, setBitwardenDefaultEnabled] = useState(false)
  const [bitwardenDefaultProfileId, setBitwardenDefaultProfileId] = useState(
    firstProfileId,
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editAlias, setEditAlias] = useState('')
  const [editName, setEditName] = useState('')
  const [replacementMaterial, setReplacementMaterial] = useState('')
  const [editScopeKind, setEditScopeKind] = useState<SecretScopeKind>('instance')
  const [editProfileId, setEditProfileId] = useState('')
  const [editDefaultProfileId, setEditDefaultProfileId] = useState(firstProfileId)
  const [editDefaultProfileIds, setEditDefaultProfileIds] = useState<Set<string>>(new Set())
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.providerId, provider])),
    [providers],
  )
  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.profileId, profile])),
    [profiles],
  )
  const projectDefaultsBySecretId = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const projectDefault of projectDefaults) {
      const profileIds = result.get(projectDefault.secretId) ?? new Set<string>()
      profileIds.add(projectDefault.profileId)
      result.set(projectDefault.secretId, profileIds)
    }
    return result
  }, [projectDefaults])
  const projectDefaultCountByProfileId = useMemo(() => {
    const result = new Map<string, number>()
    for (const projectDefault of projectDefaults) {
      result.set(
        projectDefault.profileId,
        (result.get(projectDefault.profileId) ?? 0) + 1,
      )
    }
    return result
  }, [projectDefaults])
  const isProjectDefaultLimitReached = (
    profileId: string,
    secretId?: string,
  ) => Boolean(
    profileId
    && (projectDefaultCountByProfileId.get(profileId) ?? 0)
      >= SECURE_SECRET_MAX_PROJECT_DEFAULTS
    && (!secretId || !projectDefaultsBySecretId.get(secretId)?.has(profileId))
  )
  useEffect(() => {
    const fallbackProfileId = initialProfileId ?? profiles[0]?.profileId ?? ''
    const remainsSelectable = (profileId: string) =>
      profiles.some((profile) => profile.profileId === profileId)
    const recover = (current: string) =>
      remainsSelectable(current) ? current : fallbackProfileId
    setLocalProfileId(recover)
    setLocalDefaultProfileId(recover)
    setBitwardenProfileId(recover)
    setBitwardenDefaultProfileId(recover)
    setEditProfileId(recover)
    setEditDefaultProfileId(recover)
    if (profiles.length === 0) {
      setLocalScopeKind('instance')
      setBitwardenScopeKind('instance')
      setEditScopeKind('instance')
    }
  }, [initialProfileId, profiles])
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
    const scope = scopeFor(localScopeKind, localProfileId)
    const defaultProfileId = localScopeKind === 'profile'
      ? localProfileId
      : localDefaultProfileId

    if (
      !validAlias(displayAlias)
      || !materialForSubmission
      || !scope
      || (localDefaultEnabled && !defaultProfileId)
    ) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }
    if (hasAliasCollision(secrets, displayAlias, scope)) {
      onError(new SecureSecretsError('SECURE_SECRET_ALIAS_CONFLICT'))
      return
    }
    if (localDefaultEnabled && isProjectDefaultLimitReached(defaultProfileId)) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }

    setBusyKey('create')
    let saved = false
    try {
      const created = await createLocalSecret(apiClient, {
        displayAlias: displayAlias.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        material: materialForSubmission,
        scope,
      })
      saved = true
      setDisplayAlias('')
      setDisplayName('')
      setLocalDefaultEnabled(false)
      if (localDefaultEnabled) {
        await updateSecureSecretProjectDefault(
          apiClient,
          defaultProfileId,
          created.secretId,
          true,
        )
      }
      await onChanged(
        localDefaultEnabled
          ? 'Local secret saved and enabled for new secure sessions in the selected project.'
          : 'Local secret saved. No task has access until you grant it.',
      )
    } catch (error) {
      if (saved) {
        await onChanged(
          'Local secret saved, but its automatic project availability could not be enabled.',
        )
      } else {
        onError(error)
      }
    } finally {
      setBusyKey(null)
    }
  }

  const submitBitwardenReference = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const sourceLocator = bitwardenLocator.trim()
    setBitwardenLocator('')
    const scope = scopeFor(bitwardenScopeKind, bitwardenProfileId)
    const defaultProfileId = bitwardenScopeKind === 'profile'
      ? bitwardenProfileId
      : bitwardenDefaultProfileId
    if (
      !selectedBitwardenProviderId
      || !sourceLocator
      || !validAlias(bitwardenAlias)
      || !scope
      || (bitwardenDefaultEnabled && !defaultProfileId)
    ) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }
    if (hasAliasCollision(secrets, bitwardenAlias, scope)) {
      onError(new SecureSecretsError('SECURE_SECRET_ALIAS_CONFLICT'))
      return
    }
    if (
      bitwardenDefaultEnabled
      && isProjectDefaultLimitReached(defaultProfileId)
    ) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }

    setBusyKey('import-bitwarden')
    let saved = false
    try {
      const created = await importBitwardenSecret(apiClient, {
        providerId: selectedBitwardenProviderId,
        sourceLocator,
        displayAlias: bitwardenAlias.trim(),
        ...(bitwardenName.trim() ? { displayName: bitwardenName.trim() } : {}),
        scope,
      })
      saved = true
      setBitwardenAlias('')
      setBitwardenName('')
      setBitwardenDefaultEnabled(false)
      if (bitwardenDefaultEnabled) {
        await updateSecureSecretProjectDefault(
          apiClient,
          defaultProfileId,
          created.secretId,
          true,
        )
      }
      await onChanged(
        bitwardenDefaultEnabled
          ? 'Bitwarden reference imported and enabled for new secure sessions in the selected project.'
          : 'Bitwarden secret reference imported. No task has access until you grant it.',
      )
    } catch (error) {
      if (saved) {
        await onChanged(
          'Bitwarden reference saved, but its automatic project availability could not be enabled.',
        )
      } else {
        onError(error)
      }
    } finally {
      setBusyKey(null)
    }
  }

  const beginEdit = (secret: SecureSecretSummary) => {
    const defaultProfileIds = new Set(projectDefaultsBySecretId.get(secret.secretId) ?? [])
    setEditingId(secret.secretId)
    setEditAlias(secret.displayAlias)
    setEditName(secret.displayName ?? '')
    setReplacementMaterial('')
    setEditScopeKind(secret.scope.kind)
    setEditProfileId(secret.scope.kind === 'profile' ? secret.scope.profileId : profiles[0]?.profileId ?? '')
    setEditDefaultProfileIds(defaultProfileIds)
    setEditDefaultProfileId(
      secret.scope.kind === 'profile'
        ? secret.scope.profileId
        : defaultProfileIds.values().next().value ?? profiles[0]?.profileId ?? '',
    )
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditAlias('')
    setEditName('')
    setReplacementMaterial('')
    setEditScopeKind('instance')
    setEditProfileId('')
    setEditDefaultProfileId(profiles[0]?.profileId ?? '')
    setEditDefaultProfileIds(new Set())
  }

  const saveEdit = async (secret: SecureSecretSummary) => {
    const materialForSubmission = replacementMaterial
    setReplacementMaterial('')
    const scope = scopeFor(editScopeKind, editProfileId)

    if (!validAlias(editAlias) || !scope) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }
    if (hasAliasCollision(secrets, editAlias, scope, secret.secretId)) {
      onError(new SecureSecretsError('SECURE_SECRET_ALIAS_CONFLICT'))
      return
    }

    const currentDefaultProfileIds =
      projectDefaultsBySecretId.get(secret.secretId) ?? new Set<string>()
    const nextDefaultProfileIds = scope.kind === 'profile'
      ? new Set(
          editDefaultProfileIds.has(scope.profileId) ? [scope.profileId] : [],
        )
      : editDefaultProfileIds
    const incompatibleDefaultProfileIds = scope.kind === 'profile'
      ? [...currentDefaultProfileIds].filter((profileId) => profileId !== scope.profileId)
      : []
    if ([...nextDefaultProfileIds].some(
      (profileId) => isProjectDefaultLimitReached(profileId, secret.secretId),
    )) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }
    setBusyKey(`edit:${secret.secretId}`)
    let metadataSaved = false
    try {
      const removedDefaultProfileIds: string[] = []
      try {
        for (const profileId of incompatibleDefaultProfileIds) {
          await updateSecureSecretProjectDefault(apiClient, profileId, secret.secretId, false)
          removedDefaultProfileIds.push(profileId)
        }
      } catch (error) {
        await restoreProjectDefaults(apiClient, secret.secretId, removedDefaultProfileIds)
        throw error
      }
      try {
        await updateSecureSecret(apiClient, secret.secretId, {
          displayAlias: editAlias.trim(),
          displayName: editName.trim() || null,
          ...(materialForSubmission ? { material: materialForSubmission } : {}),
          scope,
        })
        metadataSaved = true
      } catch (error) {
        await restoreProjectDefaults(
          apiClient,
          secret.secretId,
          removedDefaultProfileIds,
        )
        throw error
      }
      const remainingCurrentDefaults = new Set(
        [...currentDefaultProfileIds].filter(
          (profileId) => !incompatibleDefaultProfileIds.includes(profileId),
        ),
      )
      await reconcileProjectDefaults(
        apiClient,
        secret.secretId,
        remainingCurrentDefaults,
        nextDefaultProfileIds,
      )
      cancelEdit()
      await onChanged(
        materialForSubmission
          ? 'Secret metadata and private value updated.'
          : 'Secret metadata updated.',
      )
    } catch (error) {
      if (metadataSaved) {
        cancelEdit()
        await onChanged(
          'Secret metadata saved, but one or more project-default changes could not be completed.',
        )
      } else {
        onError(error)
      }
    } finally {
      setBusyKey(null)
    }
  }

  const removeSecret = async (secret: SecureSecretSummary) => {
    const confirmed = typeof window === 'undefined' || window.confirm(
      `Delete "${secret.displayAlias}", its saved bindings, and its project defaults? Any active secure use of this secret will stop.`,
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
                      <SecretScopeFields
                        idPrefix={`edit-${secret.secretId}`}
                        profiles={profiles}
                        scopeKind={editScopeKind}
                        profileId={editProfileId}
                        disabled={isBusy}
                        onScopeKindChange={(scopeKind) => {
                          setEditScopeKind(scopeKind)
                          if (scopeKind === 'profile') {
                            const profileId = editProfileId || profiles[0]?.profileId || ''
                            setEditProfileId(profileId)
                            setEditDefaultProfileId(profileId)
                          }
                        }}
                        onProfileIdChange={(profileId) => {
                          setEditProfileId(profileId)
                          setEditDefaultProfileId(profileId)
                        }}
                      />
                      <ProjectDefaultFields
                        idPrefix={`edit-${secret.secretId}`}
                        profiles={profiles}
                        scopeKind={editScopeKind}
                        scopeProfileId={editProfileId}
                        profileId={editDefaultProfileId}
                        enabled={
                          editScopeKind === 'profile'
                            ? editDefaultProfileIds.has(editProfileId)
                            : editDefaultProfileIds.has(editDefaultProfileId)
                        }
                        projectDefaultLimitReached={isProjectDefaultLimitReached(
                          editScopeKind === 'profile' ? editProfileId : editDefaultProfileId,
                          secret.secretId,
                        )}
                        disabled={isBusy}
                        onProfileIdChange={setEditDefaultProfileId}
                        onEnabledChange={(enabled) => {
                          const profileId = editScopeKind === 'profile'
                            ? editProfileId
                            : editDefaultProfileId
                          if (!profileId) return
                          setEditDefaultProfileIds((current) => {
                            const next = new Set(current)
                            if (enabled) next.add(profileId)
                            else next.delete(profileId)
                            return next
                          })
                        }}
                      />
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
                          <Badge variant="secondary">
                            {scopeLabel(secret.scope, profileById)}
                          </Badge>
                          {[...(projectDefaultsBySecretId.get(secret.secretId) ?? [])].map(
                            (profileId) => (
                              <Badge key={profileId} variant="outline">
                                Default in {projectName(profileId, profileById)}
                              </Badge>
                            ),
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
            <SecretScopeFields
              idPrefix="bitwarden-secret"
              profiles={profiles}
              scopeKind={bitwardenScopeKind}
              profileId={bitwardenProfileId}
              disabled={busyKey !== null}
              onScopeKindChange={(scopeKind) => {
                setBitwardenScopeKind(scopeKind)
                if (scopeKind === 'profile') {
                  const profileId = bitwardenProfileId || profiles[0]?.profileId || ''
                  setBitwardenProfileId(profileId)
                  setBitwardenDefaultProfileId(profileId)
                }
              }}
              onProfileIdChange={(profileId) => {
                setBitwardenProfileId(profileId)
                setBitwardenDefaultProfileId(profileId)
              }}
            />
            <ProjectDefaultFields
              idPrefix="bitwarden-secret"
              profiles={profiles}
              scopeKind={bitwardenScopeKind}
              scopeProfileId={bitwardenProfileId}
              profileId={bitwardenDefaultProfileId}
              enabled={bitwardenDefaultEnabled}
              projectDefaultLimitReached={isProjectDefaultLimitReached(
                bitwardenScopeKind === 'profile'
                  ? bitwardenProfileId
                  : bitwardenDefaultProfileId,
              )}
              disabled={busyKey !== null}
              onProfileIdChange={setBitwardenDefaultProfileId}
              onEnabledChange={setBitwardenDefaultEnabled}
            />
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
          <SecretScopeFields
            idPrefix="local-secret"
            profiles={profiles}
            scopeKind={localScopeKind}
            profileId={localProfileId}
            disabled={!materialEntryAvailable || busyKey !== null}
            onScopeKindChange={(scopeKind) => {
              setLocalScopeKind(scopeKind)
              if (scopeKind === 'profile') {
                const profileId = localProfileId || profiles[0]?.profileId || ''
                setLocalProfileId(profileId)
                setLocalDefaultProfileId(profileId)
              }
            }}
            onProfileIdChange={(profileId) => {
              setLocalProfileId(profileId)
              setLocalDefaultProfileId(profileId)
            }}
          />
          <ProjectDefaultFields
            idPrefix="local-secret"
            profiles={profiles}
            scopeKind={localScopeKind}
            scopeProfileId={localProfileId}
            profileId={localDefaultProfileId}
            enabled={localDefaultEnabled}
            projectDefaultLimitReached={isProjectDefaultLimitReached(
              localScopeKind === 'profile' ? localProfileId : localDefaultProfileId,
            )}
            disabled={!materialEntryAvailable || busyKey !== null}
            onProfileIdChange={setLocalDefaultProfileId}
            onEnabledChange={setLocalDefaultEnabled}
          />
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

async function reconcileProjectDefaults(
  apiClient: SettingsApiClient,
  secretId: string,
  current: Set<string>,
  next: Set<string>,
): Promise<void> {
  const changes = [
    ...[...current]
      .filter((profileId) => !next.has(profileId))
      .map((profileId) => ({ profileId, enabled: false })),
    ...[...next]
      .filter((profileId) => !current.has(profileId))
      .map((profileId) => ({ profileId, enabled: true })),
  ]
  for (const change of changes) {
    await updateSecureSecretProjectDefault(
      apiClient,
      change.profileId,
      secretId,
      change.enabled,
    )
  }
}

async function restoreProjectDefaults(
  apiClient: SettingsApiClient,
  secretId: string,
  profileIds: string[],
): Promise<void> {
  for (const profileId of profileIds) {
    await updateSecureSecretProjectDefault(apiClient, profileId, secretId, true)
  }
}

function hasAliasCollision(
  secrets: SecureSecretSummary[],
  displayAlias: string,
  scope: SecureSecretScope,
  excludeSecretId?: string,
): boolean {
  const normalizedAlias = displayAlias.trim()
  return secrets.some((secret) =>
    secret.secretId !== excludeSecretId
    && secret.displayAlias === normalizedAlias
    && sameScope(secret.scope, scope)
  )
}

function sameScope(left: SecureSecretScope, right: SecureSecretScope): boolean {
  return left.kind === right.kind
    && (left.kind === 'instance' || (
      right.kind === 'profile' && left.profileId === right.profileId
    ))
}

function validAlias(value: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value.trim())
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleDateString()
}
