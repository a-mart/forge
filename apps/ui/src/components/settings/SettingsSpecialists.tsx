import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'
import { Checkbox } from '@/components/ui/checkbox'
import { useHelpContext } from '@/components/help/help-hooks'
import { Eye, Loader2, Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
  SCOPE_CATEGORY_PREFIX,
  SCOPE_CHANNEL_PREFIX,
  parseScopeKind,
  parseCategoryId,
  parseChannelId,
} from './specialists/types'
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
import { CategorySkillDefaultsView } from './specialists/CategorySkillDefaultsView'
import { ChannelSpecialistSelection } from './specialists/ChannelSpecialistSelection'
import { ChannelSkillSelection } from './specialists/ChannelSkillSelection'
import { fetchCollabCategories, fetchCollabChannels } from './specialists-api'

export { type SettingsSpecialistsProps } from './specialists/types'

/* ================================================================== */
/*  Main component                                                     */
/* ================================================================== */

export function SettingsSpecialists({
  wsUrl,
  apiClient,
  profiles,
  specialistChangeKey,
  modelConfigChangeKey,
  initialChannelId,
}: SettingsSpecialistsProps) {
  useHelpContext('settings.specialists')
  const clientOrWsUrl: import('./settings-api-client').SettingsApiClient | string = apiClient ?? wsUrl
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

  const modelPresets = useModelPresets(clientOrWsUrl, modelConfigChangeKey, { allowDynamicPresetIds: true })
  const selectableModels = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])

  /* ---- Collab scope data ---- */
  const [collabCategories, setCollabCategories] = useState<CollaborationCategory[]>([])
  const [collabChannels, setCollabChannels] = useState<CollaborationChannel[]>([])

  useEffect(() => {
    if (!isCollab) return
    let cancelled = false

    Promise.all([
      fetchCollabCategories(clientOrWsUrl),
      fetchCollabChannels(clientOrWsUrl),
    ])
      .then(([categories, channels]) => {
        if (!cancelled) {
          setCollabCategories(categories)
          setCollabChannels(channels.filter((ch) => !ch.archived))
        }
      })
      .catch(() => {
        // Scope selector will just show Global if fetch fails
      })

    return () => { cancelled = true }
  }, [isCollab, clientOrWsUrl, specialistChangeKey])

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
  } = useSpecialistsData(clientOrWsUrl, selectedScope, isGlobal, specialistChangeKey, channelId)

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
  } = useRosterPrompt(clientOrWsUrl, selectedScope, isGlobal, channelId)

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

  /* ---- Channel skill selection state ---- */
  const selectedChannelDto = isChannel
    ? collabChannels.find((ch) => ch.channelId === channelId)
    : undefined
  const [channelSkillSelection, setChannelSkillSelection] = useState(selectedChannelDto?.activeSkillSelection)

  // Sync skill selection when channel changes
  useEffect(() => {
    setChannelSkillSelection(selectedChannelDto?.activeSkillSelection)
  }, [selectedChannelDto])

  const handleChannelSkillSelectionSaved = useCallback(
    (updated: { activeSkillSelection?: import('@forge/protocol').CollaborationSkillSelectionState }) => {
      setChannelSkillSelection(updated.activeSkillSelection)
      // Also update the channel in the local list so the DTO stays fresh
      if (channelId && updated.activeSkillSelection) {
        setCollabChannels((prev) =>
          prev.map((ch) =>
            ch.channelId === channelId
              ? { ...ch, activeSkillSelection: updated.activeSkillSelection }
              : ch,
          ),
        )
      }
    },
    [channelId],
  )

  /* ---- Category defaults saved callback ---- */
  const handleCategoryUpdated = useCallback((updated: CollaborationCategory) => {
    setCollabCategories((prev) =>
      prev.map((c) => (c.categoryId === updated.categoryId ? updated : c)),
    )
  }, [])

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
              <SelectItem value={SCOPE_GLOBAL}>
                {isCollab ? 'Global Collaboration' : 'Global'}
              </SelectItem>
              {/* Builder: show profiles */}
              {!isCollab && profiles.map((profile) => (
                <SelectItem key={profile.profileId} value={profile.profileId}>
                  {profile.displayName || profile.profileId}
                </SelectItem>
              ))}
              {/* Collab: show categories */}
              {isCollab && collabCategories.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-xs">Categories</SelectLabel>
                  {collabCategories.map((cat) => (
                    <SelectItem
                      key={`category:${cat.categoryId}`}
                      value={`${SCOPE_CATEGORY_PREFIX}${cat.categoryId}`}
                    >
                      Category: {cat.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {/* Collab: show channels */}
              {isCollab && collabChannels.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-xs">Channels</SelectLabel>
                  {collabChannels.map((ch) => (
                    <SelectItem
                      key={`channel:${ch.channelId}`}
                      value={`${SCOPE_CHANNEL_PREFIX}${ch.channelId}`}
                    >
                      #{ch.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
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

      {/* ============================================================ */}
      {/*  Category Defaults View                                       */}
      {/* ============================================================ */}
      {isCategory && selectedCategory && (
        <>
          <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
            <CategoryDefaultsView
              clientOrWsUrl={clientOrWsUrl}
              category={selectedCategory}
              specialistChangeKey={specialistChangeKey}
              onCategoryUpdated={handleCategoryUpdated}
            />
          </div>

          <CategorySkillDefaultsView
            clientOrWsUrl={clientOrWsUrl}
            category={selectedCategory}
            changeKey={specialistChangeKey}
            onCategoryUpdated={handleCategoryUpdated}
          />
        </>
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
        <>
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

          {/* Skill selection controls — not gated by specialistsEnabled (skills load independently) */}
          <ChannelSkillSelection
            clientOrWsUrl={clientOrWsUrl}
            channelId={channelId!}
            channelLabel={selectedChannelLabel}
            activeSkillSelection={channelSkillSelection}
            changeKey={specialistChangeKey}
            onSelectionSaved={handleChannelSkillSelectionSaved}
          />
        </>
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
