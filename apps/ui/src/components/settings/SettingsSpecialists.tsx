import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CollaborationCategory, ManagerReasoningLevel, TierConfig } from '@forge/protocol'
import { Checkbox } from '@/components/ui/checkbox'
import { useHelpContext } from '@/components/help/help-hooks'
import { Eye, Loader2, Plus, Save } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from './settings-row'
import {
  getAllSelectableModels,
  useModelPresets,
} from '@/lib/model-preset'
import type { SettingsSpecialistsProps } from './specialists/types'
import {
  SCOPE_GLOBAL,
  SCOPE_CHANNEL_PREFIX,
  parseScopeKind,
  parseCategoryId,
  parseChannelId,
} from './specialists/types'
import { CollabScopeSelectItems, useCollabScopeData } from './collab-scope'
import { createBuilderSettingsApiClient } from './settings-api-client'
import { useSpecialistsData } from './specialists/hooks/useSpecialistsData'
import { useCardEditing } from './specialists/hooks/useCardEditing'
import { useRosterPrompt } from './specialists/hooks/useRosterPrompt'
import { useNewSpecialistForm } from './specialists/hooks/useNewSpecialistForm'
import { useHideDisabled } from './specialists/hooks/useHideDisabled'
import { SpecialistCard } from './specialists/SpecialistCard'
import { NewSpecialistForm } from './specialists/NewSpecialistForm'
import { RosterPromptDialog } from './specialists/RosterPromptDialog'
import { PendingSaveDialog } from './specialists/PendingSaveDialog'
import { CollabSettingsBanner } from './specialists/CollabSettingsBanner'
import { CategoryDefaultsView } from './specialists/CategoryDefaultsView'
import { ChannelSpecialistSelection } from './specialists/ChannelSpecialistSelection'
import { fetchTierConfigs, saveTierConfigsApi } from './specialists-api'
import { ModelIdSelect } from './specialists/ModelIdSelect'
import { FallbackModelSection } from './specialists/FallbackModelSection'
import { REASONING_LEVEL_LABELS } from './specialists/types'
import { getSupportedReasoningLevelsForModelId } from '@/lib/model-preset'

export { type SettingsSpecialistsProps } from './specialists/types'

/* ================================================================== */
/*  Main component                                                     */
/* ================================================================== */

export function SettingsSpecialists({
  wsUrl,
  apiClient,
  profiles,
  previewSession,
  specialistChangeKey,
  modelConfigChangeKey,
  initialChannelId,
}: SettingsSpecialistsProps) {
  useHelpContext('settings.specialists')
  const clientOrWsUrl: import('./settings-api-client').SettingsApiClient | string = apiClient ?? wsUrl
  // model-preset now takes a target-aware client (never a raw wsUrl); resolve
  // one at the boundary while the other specialists-api calls keep the string.
  const presetsApiClient = useMemo(
    () => apiClient ?? createBuilderSettingsApiClient(wsUrl),
    [apiClient, wsUrl],
  )
  const isCollab = apiClient?.target.kind === 'collab'

  const [selectedScope, setSelectedScope] = useState<string>(
    initialChannelId ? `${SCOPE_CHANNEL_PREFIX}${initialChannelId}` : SCOPE_GLOBAL,
  )
  const scopeKind = parseScopeKind(selectedScope)
  const isGlobal = scopeKind === 'global'
  const isCategory = scopeKind === 'category'
  const isChannel = scopeKind === 'channel'
  const isProfile = scopeKind === 'profile'

  const channelId = isChannel ? parseChannelId(selectedScope) : undefined
  const categoryId = isCategory ? parseCategoryId(selectedScope) : undefined

  const modelPresets = useModelPresets(presetsApiClient, modelConfigChangeKey, { allowDynamicPresetIds: true })
  const selectableModels = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])
  const [tierConfigs, setTierConfigs] = useState<TierConfig[]>([])
  const [tiersLoading, setTiersLoading] = useState(false)
  const [tiersSaving, setTiersSaving] = useState(false)
  const [tiersError, setTiersError] = useState<string | null>(null)
  const [expandedTierFallbacks, setExpandedTierFallbacks] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setTiersLoading(true)
    fetchTierConfigs(clientOrWsUrl)
      .then((tiers) => {
        if (!cancelled) {
          setTierConfigs(tiers)
          setTiersError(null)
        }
      })
      .catch((error) => {
        if (!cancelled) setTiersError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setTiersLoading(false)
      })
    return () => { cancelled = true }
  }, [clientOrWsUrl, specialistChangeKey, modelConfigChangeKey])

  const updateTierConfig = useCallback((tier: string, patch: Partial<TierConfig>) => {
    setTierConfigs((prev) => prev.map((config) => config.tier === tier ? { ...config, ...patch } : config))
  }, [])

  const saveTierConfigs = useCallback(async () => {
    setTiersSaving(true)
    setTiersError(null)
    try {
      setTierConfigs(await saveTierConfigsApi(clientOrWsUrl, tierConfigs))
    } catch (error) {
      setTiersError(error instanceof Error ? error.message : String(error))
    } finally {
      setTiersSaving(false)
    }
  }, [clientOrWsUrl, tierConfigs])

  /* ---- Collab scope data (shared hook, WP-U3) ---- */
  const { collabCategories, collabChannels, setCollabCategories } = useCollabScopeData(
    clientOrWsUrl,
    isCollab,
    specialistChangeKey,
  )

  /* ---- Hooks ---- */

  const {
    specialists,
    loading,
    error,
    loadSpecialists,
    specialistsEnabled,
    enabledLoading,
    enabledToggling,
    handleToggleEnabled,
    selectedGlobalHandles,
    missingSelectedHandles,
  } = useSpecialistsData(clientOrWsUrl, selectedScope, isGlobal, specialistChangeKey, channelId, previewSession)

  const {
    editStates,
    editingIds,
    savingIds,
    cardErrors,
    expandedPromptIds,
    expandedFallbackIds,
    cloningIds,
    pendingSaveId,
    startEditing,
    cancelEditing,
    updateEditField,
    requestSave,
    confirmPendingSave,
    cancelPendingSave,
    handleCreateOverride,
    handleInheritedToggleEnabled,
    handleGlobalToggleEnabled,
    handleProfileToggleEnabled,
    handleCancelProfileEditing,
    handleRevert,
    handleDelete,
    handleClone,
    togglePromptExpand,
    toggleFallbackExpand,
    expandPromptForId,
    resetEditing,
  } = useCardEditing(clientOrWsUrl, selectedScope, isGlobal, specialists, loadSpecialists, modelPresets, channelId)

  const {
    rosterOpen,
    setRosterOpen,
    rosterMarkdown,
    rosterLoading,
    rosterError,
    handleViewRoster,
    resetRoster,
  } = useRosterPrompt(clientOrWsUrl, selectedScope, isGlobal, channelId, previewSession)

  const {
    showNewForm,
    setShowNewForm,
    newHandle,
    newDisplayName,
    normalizedNewHandle,
    handleConflict,
    newHandleValid,
    newCreating,
    newError,
    handleNewHandleChange,
    handleNewDisplayNameChange,
    handleCancelNew,
    handleCreateNew,
    resetForm: resetNewForm,
  } = useNewSpecialistForm(
    clientOrWsUrl,
    selectedScope,
    isGlobal,
    specialists,
    loadSpecialists,
    startEditing,
    expandPromptForId,
    channelId,
  )

  // Ensure selected scope stays valid when profiles change (builder only)
  useEffect(() => {
    if (isCollab) return
    setSelectedScope((prev) => {
      if (prev === SCOPE_GLOBAL) return prev
      if (profiles.some((p) => p.profileId === prev)) return prev
      return profiles.length > 0 ? profiles[0].profileId : SCOPE_GLOBAL
    })
  }, [profiles, isCollab])

  // Reset transient state on scope change
  useEffect(() => {
    resetRoster()
    resetNewForm()
    resetEditing()
  }, [selectedScope, resetRoster, resetNewForm, resetEditing])

  /* ---- Derived lists ---- */

  const { profileOverrides, inheritedSpecialists } = useMemo(() => {
    const sorted = [...specialists].sort((a, b) => a.specialistId.localeCompare(b.specialistId))
    if (isChannel) {
      // For channel scope, split by sourceKind: 'channel' is local override, rest are inherited
      return {
        profileOverrides: sorted.filter((s) => s.sourceKind === 'channel'),
        inheritedSpecialists: sorted.filter((s) => s.sourceKind !== 'channel'),
      }
    }
    return {
      profileOverrides: sorted.filter((s) => s.sourceKind === 'profile'),
      inheritedSpecialists: sorted.filter((s) => s.sourceKind !== 'profile'),
    }
  }, [specialists, isChannel])

  const { hideDisabled, handleToggleHideDisabled } = useHideDisabled()

  // Apply hide-disabled filter — never hide cards that are currently being edited
  const filteredGlobalSpecialists = useMemo(() => {
    if (!hideDisabled) return specialists
    return specialists.filter((s) => s.enabled || editingIds.has(s.specialistId))
  }, [specialists, hideDisabled, editingIds])

  const filteredProfileOverrides = useMemo(() => {
    if (!hideDisabled) return profileOverrides
    return profileOverrides.filter((s) => s.enabled || editingIds.has(s.specialistId))
  }, [profileOverrides, hideDisabled, editingIds])

  const filteredInheritedSpecialists = useMemo(() => {
    if (!hideDisabled) return inheritedSpecialists
    return inheritedSpecialists.filter((s) => s.enabled)
  }, [inheritedSpecialists, hideDisabled])

  /* ---- Channel selection saved callback ---- */
  const handleChannelSelectionSaved = useCallback(() => {
    void loadSpecialists()
  }, [loadSpecialists])

  /* ---- Category defaults saved callback ---- */
  const handleCategoryUpdated = useCallback((updated: CollaborationCategory) => {
    setCollabCategories((prev) =>
      prev.map((c) => (c.categoryId === updated.categoryId ? updated : c)),
    )
  }, [setCollabCategories])

  /* ---- Resolve category for category scope ---- */
  const selectedCategory = isCategory
    ? collabCategories.find((c) => c.categoryId === categoryId)
    : undefined

  /* ---- Resolve channel label for channel scope ---- */
  const selectedChannelLabel = isChannel
    ? collabChannels.find((ch) => ch.channelId === channelId)?.name ?? channelId ?? ''
    : ''

  /* ---- Render ---- */

  const disabledCount = useMemo(() => {
    if (isGlobal) return specialists.filter((s) => !s.enabled).length
    return [...profileOverrides, ...inheritedSpecialists].filter((s) => !s.enabled).length
  }, [isGlobal, specialists, profileOverrides, inheritedSpecialists])

  const headerButtons = (
    <div className="flex items-center gap-3">
      {disabledCount > 0 && (
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <Checkbox
            checked={hideDisabled}
            onCheckedChange={(checked) => handleToggleHideDisabled(checked === true)}
            aria-label="Hide disabled specialists"
          />
          <span className="text-xs text-muted-foreground">Hide disabled</span>
        </label>
      )}
      {(isProfile || isChannel) && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleViewRoster}
          disabled={rosterLoading}
          className="gap-1.5"
        >
          <Eye className="size-3.5" />
          Roster Prompt
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowNewForm(true)}
        disabled={showNewForm}
        className="gap-1.5"
      >
        <Plus className="size-3.5" />
        New Specialist
      </Button>
    </div>
  )

  const newFormElement = showNewForm && (
    <NewSpecialistForm
      handle={newHandle}
      displayName={newDisplayName}
      normalizedHandle={normalizedNewHandle}
      handleConflict={handleConflict}
      isValid={newHandleValid}
      isCreating={newCreating}
      error={newError}
      onHandleChange={handleNewHandleChange}
      onDisplayNameChange={handleNewDisplayNameChange}
      onCreate={handleCreateNew}
      onCancel={handleCancelNew}
    />
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Collab settings banner */}
      {isCollab && apiClient && (
        <CollabSettingsBanner apiClient={apiClient} />
      )}

      {/* Scope selector */}
      <SettingsSection
        label="Specialist Roster"
        description={isCollab
          ? 'Manage specialist worker definitions. Global collaboration specialists are shared across all channels on this server.'
          : 'Manage specialist worker definitions. Global specialists are shared across all profiles.'}
      >
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Configuration scope</Label>
          <Select value={selectedScope} onValueChange={setSelectedScope}>
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <CollabScopeSelectItems
                isCollab={isCollab}
                profiles={profiles}
                collabCategories={collabCategories}
                collabChannels={collabChannels}
                globalScopeValue={SCOPE_GLOBAL}
              />
            </SelectContent>
          </Select>
        </div>
      </SettingsSection>

      {/* Global specialists enabled toggle */}
      <SettingsSection
        label="Specialist Workers"
        description="When enabled, the manager uses named specialist workers with pre-configured models and prompts. When disabled, the manager falls back to legacy model routing guidance."
      >
        <div className="flex items-center gap-3">
          <Switch
            id="specialists-enabled-toggle"
            checked={specialistsEnabled}
            disabled={enabledLoading || enabledToggling}
            onCheckedChange={handleToggleEnabled}
            aria-label="Enable specialist workers"
          />
          <Label htmlFor="specialists-enabled-toggle" className="text-sm font-medium">
            Enable specialist workers
          </Label>
          {enabledToggling && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        {!specialistsEnabled && !enabledLoading && (
          <p className="text-xs text-muted-foreground/70 italic mt-2">
            Specialist workers are disabled. The manager will use legacy model routing guidance for worker delegation.
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        label="Tiers"
        description="Configure the global model and fallback used by each effort tier."
        cta={(
          <Button
            variant="outline"
            size="sm"
            onClick={saveTierConfigs}
            disabled={tiersSaving || tiersLoading || tierConfigs.length === 0}
            className="gap-1.5"
          >
            {tiersSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save Tiers
          </Button>
        )}
      >
        {tiersLoading ? (
          <div className="flex items-center py-3 text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" />
            Loading tiers
          </div>
        ) : (
          <div className="space-y-3">
            {tierConfigs.map((tier) => {
              const supportedLevels = getSupportedReasoningLevelsForModelId(tier.modelId, modelPresets, tier.provider)
              const fallbackExpanded = expandedTierFallbacks.has(tier.tier)
              return (
                <div key={tier.tier} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="grid gap-3 lg:grid-cols-[150px_minmax(0,1fr)_220px_150px] lg:items-start">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="size-2.5 rounded-full" style={{ backgroundColor: tier.color }} />
                        <p className="text-sm font-medium">{tier.displayName}</p>
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground">{tier.tier}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{tier.description}</p>
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">Model</Label>
                      <ModelIdSelect
                        modelId={tier.modelId}
                        provider={tier.provider}
                        onValueChange={(next) => updateTierConfig(tier.tier, {
                          provider: next.provider,
                          modelId: next.modelId,
                        })}
                        models={selectableModels}
                        presets={modelPresets}
                        placeholder="Select model"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">Reasoning</Label>
                      <Select
                        value={tier.reasoningLevel ?? 'medium'}
                        onValueChange={(reasoningLevel) => updateTierConfig(tier.tier, {
                          reasoningLevel: reasoningLevel as ManagerReasoningLevel,
                        })}
                      >
                        <SelectTrigger className="w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {supportedLevels.map((level) => (
                            <SelectItem key={level} value={level} className="text-xs">
                              {REASONING_LEVEL_LABELS[level] || level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="mt-3">
                    <FallbackModelSection
                      isEditing
                      isExpanded={fallbackExpanded}
                      onToggle={() => {
                        setExpandedTierFallbacks((prev) => {
                          const next = new Set(prev)
                          if (next.has(tier.tier)) next.delete(tier.tier)
                          else next.add(tier.tier)
                          return next
                        })
                      }}
                      fallbackModelId={tier.fallbackModelId ?? ''}
                      fallbackProvider={tier.fallbackProvider ?? ''}
                      fallbackReasoningLevel={tier.fallbackReasoningLevel ?? ''}
                      onUpdateField={(field, value) => {
                        if (typeof value !== 'string') return
                        if (field === 'fallbackModelId') updateTierConfig(tier.tier, { fallbackModelId: value || undefined })
                        if (field === 'fallbackProvider') updateTierConfig(tier.tier, { fallbackProvider: value || undefined })
                        if (field === 'fallbackReasoningLevel') updateTierConfig(tier.tier, { fallbackReasoningLevel: value as ManagerReasoningLevel || undefined })
                      }}
                      modelPresets={modelPresets}
                      selectableModels={selectableModels}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {tiersError && (
          <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{tiersError}</p>
          </div>
        )}
      </SettingsSection>

      {/* ============================================================ */}
      {/*  Category Defaults View                                       */}
      {/* ============================================================ */}
      {isCategory && selectedCategory && (
        <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
          <CategoryDefaultsView
            clientOrWsUrl={clientOrWsUrl}
            category={selectedCategory}
            specialistChangeKey={specialistChangeKey}
            onCategoryUpdated={handleCategoryUpdated}
          />
        </div>
      )}

      {isCategory && !selectedCategory && !loading && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">Category not found.</p>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Channel View — Selection + Local specialists                 */}
      {/* ============================================================ */}
      {isChannel && (
        <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
          {/* Global specialist selection controls */}
          <ChannelSpecialistSelection
            clientOrWsUrl={clientOrWsUrl}
            channelId={channelId!}
            channelLabel={selectedChannelLabel}
            selectedGlobalHandles={selectedGlobalHandles}
            missingHandles={missingSelectedHandles}
            specialistChangeKey={specialistChangeKey}
            onSelectionSaved={handleChannelSelectionSaved}
          />
        </div>
      )}

      {/* Loading / error states (for global, profile, and channel card views) */}
      {!isCategory && loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isCategory && error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Global View                                                  */}
      {/* ============================================================ */}
      {!loading && !error && isGlobal && (
        <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
        <SettingsSection
          label={isCollab ? 'Global Collaboration Specialists' : 'Global Specialists'}
          description={isCollab
            ? 'Shared collaboration specialist definitions available to all channels. Builder-only specialists may exist on this server but are hidden from collaboration rosters.'
            : 'Shared specialist definitions inherited by all profiles. Builtins are editable but cannot be deleted.'}
          cta={headerButtons}
        >
          {newFormElement}

          {filteredGlobalSpecialists.length === 0 && !showNewForm ? (
            <p className="py-3 text-sm text-muted-foreground/70 italic">
              {hideDisabled && specialists.length > 0
                ? `All ${specialists.length} specialist${specialists.length === 1 ? '' : 's'} hidden by filter.`
                : 'No global specialists found.'}
            </p>
          ) : (
            <div className="space-y-2">
              {filteredGlobalSpecialists.map((spec) => (
                <SpecialistCard
                  key={spec.specialistId}
                  mode="global"
                  specialist={spec}
                  isEditing={editingIds.has(spec.specialistId)}
                  editState={editStates[spec.specialistId]}
                  isSaving={savingIds.has(spec.specialistId)}
                  isCloning={cloningIds.has(spec.specialistId)}
                  cardError={cardErrors[spec.specialistId]}
                  isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
                  isFallbackExpanded={expandedFallbackIds.has(spec.specialistId)}
                  onExpand={() => startEditing(spec)}
                  onCancelEditing={() => cancelEditing(spec.specialistId)}
                  onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
                  onSave={() => requestSave(spec.specialistId, spec.builtin)}
                  onDelete={() => handleDelete(spec.specialistId)}
                  onClone={() => handleClone(spec)}
                  onToggleEnabled={() => handleGlobalToggleEnabled(spec)}
                  onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
                  onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
                  modelPresets={modelPresets}
                  selectableModels={selectableModels}
                  allSpecialists={specialists}
                />
              ))}
            </div>
          )}
        </SettingsSection>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Profile / Channel — Overrides                                */}
      {/* ============================================================ */}
      {!loading && !error && (isProfile || isChannel) && (
        <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
          <SettingsSection
            label={isChannel ? 'Channel Specialists' : 'Profile Customizations'}
            description={isChannel
              ? 'Channel-local specialists customize this channel only. They can shadow selected global specialists.'
              : 'Specialists customized for this profile. These take priority over inherited defaults.'}
            cta={headerButtons}
          >
            {newFormElement}

            {filteredProfileOverrides.length === 0 && !showNewForm ? (
              <p className="py-3 text-sm text-muted-foreground/70 italic">
                {hideDisabled && profileOverrides.length > 0
                  ? `All ${profileOverrides.length} customization${profileOverrides.length === 1 ? '' : 's'} hidden by filter.`
                  : isChannel
                    ? 'No channel-local specialists. Create one below or customize a global specialist.'
                    : 'No profile customizations. Override a specialist below to customize it for this profile.'}
              </p>
            ) : (
              <div className="space-y-2">
                {filteredProfileOverrides.map((spec) => (
                  <SpecialistCard
                    key={spec.specialistId}
                    mode={isChannel ? 'channelLocal' : 'profileOverride'}
                    specialist={spec}
                    isEditing={editingIds.has(spec.specialistId)}
                    editState={editStates[spec.specialistId]}
                    isSaving={savingIds.has(spec.specialistId)}
                    isCloning={cloningIds.has(spec.specialistId)}
                    cardError={cardErrors[spec.specialistId]}
                    isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
                    isFallbackExpanded={expandedFallbackIds.has(spec.specialistId)}
                    onExpand={() => startEditing(spec)}
                    onCancelEditing={() => handleCancelProfileEditing(spec.specialistId)}
                    onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
                    onSave={() => requestSave(spec.specialistId, spec.builtin)}
                    onRevert={() => handleRevert(spec.specialistId)}
                    onDelete={() => handleDelete(spec.specialistId)}
                    onClone={() => handleClone(spec)}
                    onToggleEnabled={() => handleProfileToggleEnabled(spec)}
                    onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
                    onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
                    modelPresets={modelPresets}
                    selectableModels={selectableModels}
                    allSpecialists={specialists}
                  />
                ))}
              </div>
            )}
          </SettingsSection>

          {/* ============================================================ */}
          {/*  Profile / Channel — Inherited                               */}
          {/* ============================================================ */}
          {inheritedSpecialists.length > 0 && (
            <SettingsSection
              label={isChannel ? 'Selected Global Specialists' : 'Inherited Specialists'}
              description={isChannel
                ? 'Global collaboration specialists selected for this channel. Click to create a channel-local customization.'
                : 'Baseline specialists from builtin and global definitions. Customize any of these to create a profile-specific version.'}
            >
              {filteredInheritedSpecialists.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground/70 italic">
                  All {inheritedSpecialists.length} inherited specialist{inheritedSpecialists.length === 1 ? '' : 's'} hidden by filter.
                </p>
              ) : (
              <div className="space-y-2">
                {filteredInheritedSpecialists.map((spec) => (
                  <SpecialistCard
                    key={spec.specialistId}
                    mode="inherited"
                    specialist={spec}
                    isEditing={false}
                    editState={undefined}
                    isSaving={savingIds.has(spec.specialistId)}
                    isCloning={cloningIds.has(spec.specialistId)}
                    cardError={cardErrors[spec.specialistId]}
                    isPromptExpanded={false}
                    isFallbackExpanded={false}
                    onExpand={() => handleCreateOverride(spec)}
                    onCancelEditing={() => {}}
                    onUpdateField={() => {}}
                    onSave={() => {}}
                    onClone={() => handleClone(spec)}
                    onToggleEnabled={() => handleInheritedToggleEnabled(spec)}
                    onTogglePrompt={() => {}}
                    onToggleFallback={() => {}}
                    modelPresets={modelPresets}
                    selectableModels={selectableModels}
                    allSpecialists={specialists}
                  />
                ))}
              </div>
              )}
            </SettingsSection>
          )}
        </div>
      )}

      {/* Roster prompt dialog */}
      <RosterPromptDialog
        open={rosterOpen}
        onOpenChange={setRosterOpen}
        loading={rosterLoading}
        error={rosterError}
        markdown={rosterMarkdown}
      />

      {/* Pending save confirmation dialog */}
      <PendingSaveDialog
        open={pendingSaveId !== null}
        isSaving={pendingSaveId ? savingIds.has(pendingSaveId) : false}
        onConfirm={confirmPendingSave}
        onCancel={cancelPendingSave}
        onOpenChange={(open) => {
          if (!open) cancelPendingSave()
        }}
      />
    </div>
  )
}
