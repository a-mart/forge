import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PrivateValueTextarea } from '@/components/secure-session/PrivateValueTextarea'
import { PasswordGenerator } from '@/components/secure-session/PasswordGenerator'
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
  createBitwardenPasswordManagerSecret,
  createLocalSecret,
  deleteSecureSecret,
  importBitwardenSecret,
  fetchBitwardenPasswordManagerSettings,
  updateSecureSecretAutomaticGrant,
  updateSecureSecret,
  type SecureSecretAutomaticGrantPolicy,
  type SecureSecretProjectDefaultSummary,
  type SecureSecretProviderSummary,
  type SecureSecretScope,
  type SecureSecretSummary,
  type BitwardenPasswordManagerCollectionSummary,
} from '@/lib/secure-secrets-api'
import { EmptyState } from './secret-ui'
import { providerLabel } from './secret-ui-values'
import {
  AutomaticGrantFields,
  SecretScopeFields,
} from './SecretProjectAccessFields'
import {
  projectName,
  scopeFor,
  scopeKindFor,
  scopeLabel,
  scopeProfileIds,
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
  maxProjectDefaults?: number
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
  maxProjectDefaults = SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  onChanged,
  onError,
}: SecretCatalogPanelProps) {
  const firstProfileId = initialProfileId ?? profiles[0]?.profileId ?? ''
  const [displayAlias, setDisplayAlias] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [note, setNote] = useState('')
  const [material, setMaterial] = useState('')
  const [localScopeKind, setLocalScopeKind] = useState<SecretScopeKind>(
    profiles.length > 0 ? 'projects' : 'instance',
  )
  const [localScopeProfileIds, setLocalScopeProfileIds] = useState<Set<string>>(
    new Set(firstProfileId ? [firstProfileId] : []),
  )
  const [localAutomaticProfileIds, setLocalAutomaticProfileIds] = useState<Set<string>>(
    new Set(),
  )
  const [localEveryProject, setLocalEveryProject] = useState(false)
  const [bitwardenProviderId, setBitwardenProviderId] = useState('')
  const [bitwardenLocator, setBitwardenLocator] = useState('')
  const [bitwardenAlias, setBitwardenAlias] = useState('')
  const [bitwardenName, setBitwardenName] = useState('')
  const [bitwardenScopeKind, setBitwardenScopeKind] = useState<SecretScopeKind>(
    profiles.length > 0 ? 'projects' : 'instance',
  )
  const [bitwardenScopeProfileIds, setBitwardenScopeProfileIds] =
    useState<Set<string>>(
      new Set(firstProfileId ? [firstProfileId] : []),
  )
  const [bitwardenAutomaticProfileIds, setBitwardenAutomaticProfileIds] =
    useState<Set<string>>(new Set())
  const [bitwardenEveryProject, setBitwardenEveryProject] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editAlias, setEditAlias] = useState('')
  const [editName, setEditName] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editNote, setEditNote] = useState('')
  const [replacementMaterial, setReplacementMaterial] = useState('')
  const [editScopeKind, setEditScopeKind] = useState<SecretScopeKind>('instance')
  const [editScopeProfileIds, setEditScopeProfileIds] =
    useState<Set<string>>(new Set())
  const [editAutomaticProfileIds, setEditAutomaticProfileIds] =
    useState<Set<string>>(new Set())
  const [editEveryProject, setEditEveryProject] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [secretSearch, setSecretSearch] = useState('')
  const [saveDestination, setSaveDestination] = useState('local')
  const [passwordManagerCollections, setPasswordManagerCollections] = useState<Array<{
    providerId: string
    providerName: string
    collection: BitwardenPasswordManagerCollectionSummary
  }>>([])
  const selectedPasswordManagerDestination = passwordManagerCollections.find(
    (candidate) => passwordManagerDestinationKey(candidate) === saveDestination,
  )

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.providerId, provider])),
    [providers],
  )
  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.profileId, profile])),
    [profiles],
  )
  const filteredSecrets = useMemo(() => {
    const query = secretSearch.trim().toLowerCase()
    if (!query) return secrets

    return secrets.filter((secret) => {
      const searchableValues = [
        secret.displayAlias,
        secret.displayName,
        secret.username,
        secret.note,
        providerLabel(secret.providerId, providers),
        scopeLabel(secret.scope, profileById),
        ...scopeProfileIds(secret.scope).map((profileId) =>
          projectName(profileId, profileById)
        ),
        ...secret.bindings.flatMap((binding) =>
          Object.values(binding).filter((value): value is string => typeof value === 'string')
        ),
      ]
      return searchableValues.some((value) => value?.toLowerCase().includes(query))
    })
  }, [profileById, providers, secretSearch, secrets])
  const projectDefaultsBySecretId = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const projectDefault of projectDefaults) {
      const profileIds = result.get(projectDefault.secretId) ?? new Set<string>()
      profileIds.add(projectDefault.profileId)
      result.set(projectDefault.secretId, profileIds)
    }
    return result
  }, [projectDefaults])
  const automaticGrantPolicyBySecretId = useMemo(() => {
    const result = new Map<string, SecureSecretAutomaticGrantPolicy>()
    for (const secret of secrets) {
      const legacyProfileIds = projectDefaultsBySecretId.get(secret.secretId)
      result.set(
        secret.secretId,
        secret.automaticGrantPolicy
          ?? (legacyProfileIds?.size
            ? { kind: 'projects', profileIds: [...legacyProfileIds] }
            : { kind: 'none' }),
      )
    }
    return result
  }, [projectDefaultsBySecretId, secrets])
  const automaticGrantCountByProfileId = useMemo(() => {
    const effectiveSecretIdsByProfileId = new Map<string, Set<string>>()
    for (const projectDefault of projectDefaults) {
      const secretIds =
        effectiveSecretIdsByProfileId.get(projectDefault.profileId) ?? new Set<string>()
      secretIds.add(projectDefault.secretId)
      effectiveSecretIdsByProfileId.set(projectDefault.profileId, secretIds)
    }
    for (const [secretId, policy] of automaticGrantPolicyBySecretId) {
      const profileIds = policy.kind === 'all_projects'
        ? profiles.map((profile) => profile.profileId)
        : policy.kind === 'projects'
          ? policy.profileIds
          : []
      for (const profileId of new Set(profileIds)) {
        const secretIds = effectiveSecretIdsByProfileId.get(profileId) ?? new Set<string>()
        secretIds.add(secretId)
        effectiveSecretIdsByProfileId.set(profileId, secretIds)
      }
    }
    return new Map(
      [...effectiveSecretIdsByProfileId].map(
        ([profileId, secretIds]) => [profileId, secretIds.size],
      ),
    )
  }, [automaticGrantPolicyBySecretId, profiles, projectDefaults])
  const allProjectsAutomaticGrantCount = useMemo(
    () => [...automaticGrantPolicyBySecretId.values()].filter(
      (policy) => policy.kind === 'all_projects',
    ).length,
    [automaticGrantPolicyBySecretId],
  )
  const isAutomaticGrantLimitReached = (
    profileId: string,
    secretId?: string,
  ) => Boolean(
    profileId
    && (automaticGrantCountByProfileId.get(profileId) ?? 0)
      >= maxProjectDefaults
    && (!secretId || !policyAppliesToProfile(
      automaticGrantPolicyBySecretId.get(secretId),
      profileId,
    ))
  )
  const isEveryProjectLimitReached = (secretId?: string) =>
    allProjectsAutomaticGrantCount >= maxProjectDefaults
    && automaticGrantPolicyBySecretId.get(secretId ?? '')?.kind !== 'all_projects'
  const limitReachedProfileIds = (secretId?: string) => new Set(
    profiles
      .filter((profile) => isAutomaticGrantLimitReached(profile.profileId, secretId))
      .map((profile) => profile.profileId),
  )
  useEffect(() => {
    const fallbackProfileId = initialProfileId ?? profiles[0]?.profileId ?? ''
    const remainsSelectable = (profileId: string) =>
      profiles.some((profile) => profile.profileId === profileId)
    const prune = (current: Set<string>) => new Set(
      [...current].filter(remainsSelectable),
    )
    const recoverScope = (current: Set<string>) => {
      const next = prune(current)
      if (next.size === 0 && fallbackProfileId) next.add(fallbackProfileId)
      return next
    }
    setLocalScopeProfileIds(recoverScope)
    setBitwardenScopeProfileIds(recoverScope)
    setEditScopeProfileIds(prune)
    setLocalAutomaticProfileIds(prune)
    setBitwardenAutomaticProfileIds(prune)
    setEditAutomaticProfileIds(prune)
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

  useEffect(() => {
    let active = true
    const passwordManagers = providers.filter(
      (provider) => provider.kind === 'bitwarden_password_manager'
        && provider.enabled
        && provider.status === 'available',
    )
    void Promise.all(passwordManagers.map(async (provider) => ({
      provider,
      settings: await fetchBitwardenPasswordManagerSettings(apiClient, provider.providerId),
    }))).then((results) => {
      if (!active) return
      const collections = results.flatMap(({ provider, settings }) =>
        settings.collections
          .filter((collection) => collection.selected)
          .map((collection) => ({
            providerId: provider.providerId,
            providerName: provider.displayName,
            collection,
          })),
      )
      setPasswordManagerCollections(collections)
    }).catch(() => {
      if (active) setPasswordManagerCollections([])
    })
    return () => { active = false }
  }, [apiClient, providers])

  const submitLocalSecret = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const materialForSubmission = material
    setMaterial('')
    const scope = scopeFor(localScopeKind, localScopeProfileIds)
    const automaticGrantPolicy = automaticGrantPolicyFor(
      scope,
      localAutomaticProfileIds,
      localEveryProject,
    )

    if (
      !validAlias(displayAlias)
      || !materialForSubmission
      || !scope
      || !automaticGrantPolicy
    ) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }
    if (hasAliasCollision(secrets, displayAlias, scope)) {
      onError(new SecureSecretsError('SECURE_SECRET_ALIAS_CONFLICT'))
      return
    }
    if (
      automaticGrantPolicy.kind === 'projects'
      && automaticGrantPolicy.profileIds.some((profileId) =>
        isAutomaticGrantLimitReached(profileId)
      )
    ) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }
    if (
      automaticGrantPolicy.kind === 'all_projects'
      && (
        isEveryProjectLimitReached()
        || profiles.some((profile) =>
          isAutomaticGrantLimitReached(profile.profileId)
        )
      )
    ) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }

    setBusyKey('create')
    let saved = false
    try {
      const selectedPasswordManager = passwordManagerCollections.find(
        (candidate) => passwordManagerDestinationKey(candidate) === saveDestination,
      )
      const createInput = {
        displayAlias: displayAlias.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        material: materialForSubmission,
        scope,
      }
      const created = selectedPasswordManager
        ? await createBitwardenPasswordManagerSecret(
            apiClient,
            selectedPasswordManager.providerId,
            {
              ...createInput,
              collectionId: selectedPasswordManager.collection.collectionId,
            },
          )
        : await createLocalSecret(apiClient, createInput)
      saved = true
      setDisplayAlias('')
      setDisplayName('')
      setUsername('')
      setNote('')
      setLocalAutomaticProfileIds(new Set())
      setLocalEveryProject(false)
      if (automaticGrantPolicy.kind !== 'none') {
        await updateSecureSecretAutomaticGrant(
          apiClient,
          created.secretId,
          automaticGrantPolicy,
        )
      }
      await onChanged(
        automaticGrantPolicy.kind !== 'none'
          ? 'Secret saved with its automatic grant policy.'
          : 'Secret saved. No task has access until you grant it.',
      )
    } catch (error) {
      if (saved) {
        await onChanged(
          'Secret saved, but its automatic grant policy could not be enabled.',
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
    const scope = scopeFor(bitwardenScopeKind, bitwardenScopeProfileIds)
    const automaticGrantPolicy = automaticGrantPolicyFor(
      scope,
      bitwardenAutomaticProfileIds,
      bitwardenEveryProject,
    )
    if (
      !selectedBitwardenProviderId
      || !sourceLocator
      || !validAlias(bitwardenAlias)
      || !scope
      || !automaticGrantPolicy
    ) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }
    if (hasAliasCollision(secrets, bitwardenAlias, scope)) {
      onError(new SecureSecretsError('SECURE_SECRET_ALIAS_CONFLICT'))
      return
    }
    if (
      automaticGrantPolicy.kind === 'projects'
      && automaticGrantPolicy.profileIds.some((profileId) =>
        isAutomaticGrantLimitReached(profileId)
      )
    ) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }
    if (
      automaticGrantPolicy.kind === 'all_projects'
      && (
        isEveryProjectLimitReached()
        || profiles.some((profile) =>
          isAutomaticGrantLimitReached(profile.profileId)
        )
      )
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
      setBitwardenAutomaticProfileIds(new Set())
      setBitwardenEveryProject(false)
      if (automaticGrantPolicy.kind !== 'none') {
        await updateSecureSecretAutomaticGrant(
          apiClient,
          created.secretId,
          automaticGrantPolicy,
        )
      }
      await onChanged(
        automaticGrantPolicy.kind !== 'none'
          ? 'Bitwarden reference imported with its automatic grant policy.'
          : 'Bitwarden secret reference imported. No task has access until you grant it.',
      )
    } catch (error) {
      if (saved) {
        await onChanged(
          'Bitwarden reference saved, but its automatic grant policy could not be enabled.',
        )
      } else {
        onError(error)
      }
    } finally {
      setBusyKey(null)
    }
  }

  const beginEdit = (secret: SecureSecretSummary) => {
    const automaticGrantPolicy =
      automaticGrantPolicyBySecretId.get(secret.secretId) ?? { kind: 'none' }
    setEditingId(secret.secretId)
    setEditAlias(secret.displayAlias)
    setEditName(secret.displayName ?? '')
    setEditUsername(secret.username ?? '')
    setEditNote(secret.note ?? '')
    setReplacementMaterial('')
    setEditScopeKind(scopeKindFor(secret.scope))
    setEditScopeProfileIds(new Set(scopeProfileIds(secret.scope)))
    setEditAutomaticProfileIds(
      automaticGrantPolicy.kind === 'projects'
        ? new Set(automaticGrantPolicy.profileIds)
        : new Set(),
    )
    setEditEveryProject(automaticGrantPolicy.kind === 'all_projects')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditAlias('')
    setEditName('')
    setEditUsername('')
    setEditNote('')
    setReplacementMaterial('')
    setEditScopeKind('instance')
    setEditScopeProfileIds(new Set())
    setEditAutomaticProfileIds(new Set())
    setEditEveryProject(false)
  }

  const saveEdit = async (secret: SecureSecretSummary) => {
    const materialForSubmission = replacementMaterial
    setReplacementMaterial('')
    const scope = scopeFor(editScopeKind, editScopeProfileIds)
    const automaticGrantPolicy = automaticGrantPolicyFor(
      scope,
      editAutomaticProfileIds,
      editEveryProject,
    )

    if (!validAlias(editAlias) || !scope || !automaticGrantPolicy) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }
    if (hasAliasCollision(secrets, editAlias, scope, secret.secretId)) {
      onError(new SecureSecretsError('SECURE_SECRET_ALIAS_CONFLICT'))
      return
    }

    if (
      automaticGrantPolicy.kind === 'projects'
      && automaticGrantPolicy.profileIds.some((profileId) =>
        isAutomaticGrantLimitReached(profileId, secret.secretId)
      )
    ) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }
    if (
      automaticGrantPolicy.kind === 'all_projects'
      && (
        isEveryProjectLimitReached(secret.secretId)
        || profiles.some((profile) =>
          isAutomaticGrantLimitReached(profile.profileId, secret.secretId)
        )
      )
    ) {
      onError(new SecureSecretsError('SECURE_PROJECT_DEFAULT_LIMIT_REACHED'))
      return
    }
    setBusyKey(`edit:${secret.secretId}`)
    let metadataSaved = false
    try {
      await updateSecureSecret(apiClient, secret.secretId, {
        displayAlias: editAlias.trim(),
        displayName: editName.trim() || null,
        username: editUsername.trim() || null,
        note: editNote.trim() || null,
        ...(materialForSubmission ? { material: materialForSubmission } : {}),
        scope,
      })
      metadataSaved = true
      await updateSecureSecretAutomaticGrant(
        apiClient,
        secret.secretId,
        automaticGrantPolicy,
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
          'Secret metadata saved, but its automatic grant policy could not be updated.',
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
      `Delete "${secret.displayAlias}", its saved bindings, and its automatic grant policy? Any active secure use of this secret will stop.`,
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
            These entries identify stored sources. They are not active task grants, and saved values
            are never returned or revealed.
          </p>
        </div>

        {secrets.length > 0 ? (
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search saved secrets"
              value={secretSearch}
              onChange={(event) => setSecretSearch(event.target.value)}
              placeholder="Search by name, alias, note, source, project, or binding"
              className="pl-9"
            />
          </div>
        ) : null}

        {secrets.length === 0 ? (
          <EmptyState
            title="No saved secrets"
            description="Add a local secret below or connect a source that supplies secret metadata."
          />
        ) : filteredSecrets.length === 0 ? (
          <EmptyState
            title="No matching secrets"
            description="Try a different name, alias, note, source, project, or binding."
          />
        ) : (
          <div className="space-y-2">
            {filteredSecrets.map((secret) => {
              const provider = providerById.get(secret.providerId)
              const isLocal = provider?.kind === 'local_keychain'
              const isEditing = editingId === secret.secretId
              const isBusy = busyKey?.endsWith(secret.secretId) ?? false
              const automaticGrantPolicy =
                automaticGrantPolicyBySecretId.get(secret.secretId) ?? { kind: 'none' }

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
                        <Field label="Username (optional)" htmlFor={`edit-username-${secret.secretId}`}>
                          <Input
                            id={`edit-username-${secret.secretId}`}
                            value={editUsername}
                            onChange={(event) => setEditUsername(event.target.value)}
                            maxLength={512}
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={isBusy}
                          />
                        </Field>
                      </div>
                      <Field label="Note (optional)" htmlFor={`edit-note-${secret.secretId}`}>
                        <Textarea
                          id={`edit-note-${secret.secretId}`}
                          value={editNote}
                          onChange={(event) => setEditNote(event.target.value)}
                          placeholder="What this secret is for or when to use it"
                          maxLength={2000}
                          disabled={isBusy}
                        />
                      </Field>
                      <SecretScopeFields
                        idPrefix={`edit-${secret.secretId}`}
                        profiles={profiles}
                        scopeKind={editScopeKind}
                        selectedProfileIds={editScopeProfileIds}
                        disabled={isBusy}
                        onScopeKindChange={(scopeKind) => {
                          setEditScopeKind(scopeKind)
                          if (scopeKind === 'projects') {
                            setEditEveryProject(false)
                          }
                        }}
                        onProfileCheckedChange={(profileId, checked) => {
                          setEditScopeProfileIds((current) =>
                            withProfileChecked(current, profileId, checked)
                          )
                          if (!checked) {
                            setEditAutomaticProfileIds((current) =>
                              withProfileChecked(current, profileId, false)
                            )
                          }
                        }}
                      />
                      <AutomaticGrantFields
                        idPrefix={`edit-${secret.secretId}`}
                        profiles={profiles}
                        scopeKind={editScopeKind}
                        scopeProfileIds={editScopeProfileIds}
                        selectedProfileIds={editAutomaticProfileIds}
                        everyProject={editEveryProject}
                        limitReachedProfileIds={limitReachedProfileIds(secret.secretId)}
                        everyProjectLimitReached={isEveryProjectLimitReached(secret.secretId)}
                        maxProjectDefaults={maxProjectDefaults}
                        disabled={isBusy}
                        onProfileCheckedChange={(profileId, checked) => {
                          setEditAutomaticProfileIds((current) =>
                            withProfileChecked(current, profileId, checked)
                          )
                        }}
                        onEveryProjectChange={setEditEveryProject}
                      />
                      {isLocal ? (
                        <Field
                          label="Replace private value (optional)"
                          htmlFor={`replace-material-${secret.secretId}`}
                        >
                          <PrivateValueTextarea
                            id={`replace-material-${secret.secretId}`}
                            value={replacementMaterial}
                            onValueChange={setReplacementMaterial}
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
                          {automaticGrantPolicy.kind === 'all_projects' ? (
                            <Badge variant="outline">
                              Automatically granted in every project
                            </Badge>
                          ) : null}
                          {automaticGrantPolicy.kind === 'projects'
                            ? automaticGrantPolicy.profileIds.map(
                              (profileId) => (
                                <Badge key={profileId} variant="outline">
                                  Automatically granted in {projectName(profileId, profileById)}
                                </Badge>
                              ),
                            )
                            : null}
                        </div>
                        {secret.displayName ? (
                          <p className="text-sm text-muted-foreground">{secret.displayName}</p>
                        ) : null}
                        {secret.username ? (
                          <p className="text-sm text-muted-foreground">
                            Username: <span className="font-mono text-foreground">{secret.username}</span>
                          </p>
                        ) : null}
                        {secret.note ? (
                          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                            {secret.note}
                          </p>
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
              selectedProfileIds={bitwardenScopeProfileIds}
              disabled={busyKey !== null}
              onScopeKindChange={(scopeKind) => {
                setBitwardenScopeKind(scopeKind)
                if (scopeKind === 'projects') {
                  setBitwardenEveryProject(false)
                }
              }}
              onProfileCheckedChange={(profileId, checked) => {
                setBitwardenScopeProfileIds((current) =>
                  withProfileChecked(current, profileId, checked)
                )
                if (!checked) {
                  setBitwardenAutomaticProfileIds((current) =>
                    withProfileChecked(current, profileId, false)
                  )
                }
              }}
            />
            <AutomaticGrantFields
              idPrefix="bitwarden-secret"
              profiles={profiles}
              scopeKind={bitwardenScopeKind}
              scopeProfileIds={bitwardenScopeProfileIds}
              selectedProfileIds={bitwardenAutomaticProfileIds}
              everyProject={bitwardenEveryProject}
              limitReachedProfileIds={limitReachedProfileIds()}
              everyProjectLimitReached={isEveryProjectLimitReached()}
              maxProjectDefaults={maxProjectDefaults}
              disabled={busyKey !== null}
              onProfileCheckedChange={(profileId, checked) => {
                setBitwardenAutomaticProfileIds((current) =>
                  withProfileChecked(current, profileId, checked)
                )
              }}
              onEveryProjectChange={setBitwardenEveryProject}
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
          <h3 className="text-base font-semibold">
            {saveDestination === 'local' ? 'Add local secret' : 'Add Bitwarden login'}
          </h3>
          <p className="text-sm text-muted-foreground">
            The private value stays visible while you enter it and is cleared from this form as soon
            as you submit. Saved values cannot be revealed later.
          </p>
        </div>

        <form className="space-y-4 rounded-md border border-border/70 p-4" onSubmit={submitLocalSecret}>
          <Field label="Store in" htmlFor="secret-save-destination">
            <Select
              value={saveDestination}
              onValueChange={setSaveDestination}
              disabled={!materialEntryAvailable || busyKey !== null}
            >
              <SelectTrigger id="secret-save-destination" className="w-full">
                <span data-slot="select-value">
                  {saveDestination === 'local'
                    ? 'Local Forge vault'
                    : selectedPasswordManagerDestination
                      ? `${selectedPasswordManagerDestination.providerName} — ${selectedPasswordManagerDestination.collection.name}`
                      : 'Choose storage'}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local Forge vault</SelectItem>
                {passwordManagerCollections.map((candidate) => (
                  <SelectItem
                    key={passwordManagerDestinationKey(candidate)}
                    value={passwordManagerDestinationKey(candidate)}
                  >
                    {candidate.providerName} — {candidate.collection.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
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
          <Field label="Note (optional)" htmlFor="local-secret-note">
            <Textarea
              id="local-secret-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What this secret is for or when to use it"
              maxLength={2000}
              disabled={!materialEntryAvailable || busyKey !== null}
            />
            <p className="text-xs text-muted-foreground">
              Visible in Forge settings. Do not include the secret value.
            </p>
          </Field>
          <Field label="Username (optional)" htmlFor="local-secret-username">
            <Input
              id="local-secret-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={512}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="name@example.com"
              disabled={!materialEntryAvailable || busyKey !== null}
            />
            <p className="text-xs text-muted-foreground">
              Visible to agents as login metadata; the private value remains protected.
            </p>
          </Field>
          <Field label="Private value" htmlFor="local-secret-material">
            <PrivateValueTextarea
              id="local-secret-material"
              name="localSecretMaterial"
              value={material}
              onValueChange={setMaterial}
              autoComplete="new-password"
              placeholder="Paste value"
              disabled={!materialEntryAvailable || busyKey !== null}
            />
          </Field>
          <PasswordGenerator
            disabled={!materialEntryAvailable || busyKey !== null}
            onGenerate={setMaterial}
          />
          <SecretScopeFields
            idPrefix="local-secret"
            profiles={profiles}
            scopeKind={localScopeKind}
            selectedProfileIds={localScopeProfileIds}
            disabled={!materialEntryAvailable || busyKey !== null}
            onScopeKindChange={(scopeKind) => {
              setLocalScopeKind(scopeKind)
              if (scopeKind === 'projects') {
                setLocalEveryProject(false)
              }
            }}
            onProfileCheckedChange={(profileId, checked) => {
              setLocalScopeProfileIds((current) =>
                withProfileChecked(current, profileId, checked)
              )
              if (!checked) {
                setLocalAutomaticProfileIds((current) =>
                  withProfileChecked(current, profileId, false)
                )
              }
            }}
          />
          <AutomaticGrantFields
            idPrefix="local-secret"
            profiles={profiles}
            scopeKind={localScopeKind}
            scopeProfileIds={localScopeProfileIds}
            selectedProfileIds={localAutomaticProfileIds}
            everyProject={localEveryProject}
            limitReachedProfileIds={limitReachedProfileIds()}
            everyProjectLimitReached={isEveryProjectLimitReached()}
            maxProjectDefaults={maxProjectDefaults}
            disabled={!materialEntryAvailable || busyKey !== null}
            onProfileCheckedChange={(profileId, checked) => {
              setLocalAutomaticProfileIds((current) =>
                withProfileChecked(current, profileId, checked)
              )
            }}
            onEveryProjectChange={setLocalEveryProject}
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
            {saveDestination === 'local' ? 'Save local secret' : 'Save to Bitwarden'}
          </Button>
        </form>
      </section>
    </div>
  )
}

function passwordManagerDestinationKey(input: {
  providerId: string
  collection: Pick<BitwardenPasswordManagerCollectionSummary, 'collectionId'>
}): string {
  return `${input.providerId}:${input.collection.collectionId}`
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

function automaticGrantPolicyFor(
  scope: SecureSecretScope | null,
  selectedProfileIds: Set<string>,
  everyProject: boolean,
): SecureSecretAutomaticGrantPolicy | null {
  if (!scope) return null
  if (everyProject) {
    return scope.kind === 'instance' ? { kind: 'all_projects' } : null
  }
  const availableProfileIds = scope.kind === 'instance'
    ? null
    : new Set(scopeProfileIds(scope))
  const profileIds = [...selectedProfileIds]
    .filter((profileId) =>
      availableProfileIds === null || availableProfileIds.has(profileId)
    )
    .sort()
  return profileIds.length > 0
    ? { kind: 'projects', profileIds }
    : { kind: 'none' }
}

function policyAppliesToProfile(
  policy: SecureSecretAutomaticGrantPolicy | undefined,
  profileId: string,
): boolean {
  return policy?.kind === 'all_projects'
    || (policy?.kind === 'projects' && policy.profileIds.includes(profileId))
}

function withProfileChecked(
  current: Set<string>,
  profileId: string,
  checked: boolean,
): Set<string> {
  const next = new Set(current)
  if (checked) next.add(profileId)
  else next.delete(profileId)
  return next
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
  if (left.kind === 'instance' || right.kind === 'instance') {
    return left.kind === 'instance' && right.kind === 'instance'
  }
  const rightProfileIds = new Set(scopeProfileIds(right))
  return scopeProfileIds(left).some((profileId) => rightProfileIds.has(profileId))
}

function validAlias(value: string): boolean {
  return value.trim().length > 0
    && value.length <= 256
    && !value.includes('\0')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleDateString()
}
