import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CollaborationCategory } from '@forge/protocol'
import { Checkbox } from '@/components/ui/checkbox'
import { useHelpContext } from '@/components/help/help-hooks'
import { Eye, Loader2, Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
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
import { DelegationRosterSettingsView } from './specialists/DelegationRosterSettings'
import {
  getBehaviorModeCardMetadata,
  isDelegationChoiceSpecialist,
  SYSTEM_DELEGATION_SPECIALIST_IDS,
} from './specialists/utils'

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

  const visibleSpecialists = useMemo(
    () => specialists.filter((specialist) => isDelegationChoiceSpecialist(specialist.specialistId)),
    [specialists],
  )

  const systemSpecialists = useMemo(
    () => specialists
      .filter((specialist) => SYSTEM_DELEGATION_SPECIALIST_IDS.has(specialist.specialistId))
      .sort((a, b) => a.specialistId.localeCompare(b.specialistId)),
    [specialists],
  )

  const { profileOverrides, inheritedSpecialists } = useMemo(() => {
    const sorted = [...visibleSpecialists].sort((a, b) => a.specialistId.localeCompare(b.specialistId))
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
  }, [visibleSpecialists, isChannel])

  const { hideDisabled, handleToggleHideDisabled } = useHideDisabled()

  // Apply hide-disabled filter — never hide cards that are currently being edited
  const filteredGlobalSpecialists = useMemo(() => {
    if (!hideDisabled) return visibleSpecialists
    return visibleSpecialists.filter((s) => s.enabled || editingIds.has(s.specialistId))
  }, [visibleSpecialists, hideDisabled, editingIds])

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

  const renderSystemSpecialistCard = (spec: (typeof systemSpecialists)[number]) => {
    const isLocal = isGlobal || (isChannel
      ? spec.sourceKind === 'channel'
      : spec.sourceKind === 'profile')
    const cardMode = isGlobal
      ? 'global' as const
      : isLocal
        ? (isChannel ? 'channelLocal' as const : 'profileOverride' as const)
        : 'inherited' as const

    return (
      <SpecialistCard
        key={spec.specialistId}
        mode={cardMode}
        specialist={spec}
        isEditing={isLocal && editingIds.has(spec.specialistId)}
        editState={isLocal ? editStates[spec.specialistId] : undefined}
        isSaving={savingIds.has(spec.specialistId)}
        isCloning={cloningIds.has(spec.specialistId)}
        cardError={cardErrors[spec.specialistId]}
        isPromptExpanded={isLocal && expandedPromptIds.has(spec.specialistId)}
        isFallbackExpanded={isLocal && expandedFallbackIds.has(spec.specialistId)}
        onExpand={() => isLocal ? startEditing(spec) : handleCreateOverride(spec)}
        onCancelEditing={() => isGlobal
          ? cancelEditing(spec.specialistId)
          : handleCancelProfileEditing(spec.specialistId)}
        onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
        onSave={() => requestSave(spec.specialistId, spec.builtin)}
        onRevert={isGlobal ? undefined : () => handleRevert(spec.specialistId)}
        onDelete={() => handleDelete(spec.specialistId)}
        onClone={spec.specialistId === 'codex-plugin' ? undefined : () => handleClone(spec)}
        onToggleEnabled={() => isGlobal
          ? handleGlobalToggleEnabled(spec)
          : isLocal
            ? handleProfileToggleEnabled(spec)
            : handleInheritedToggleEnabled(spec)}
        onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
        onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
        allSpecialists={specialists}
      />
    )
  }

  /* ---- Render ---- */

  const disabledCount = useMemo(() => {
    if (isGlobal) return visibleSpecialists.filter((s) => !s.enabled).length
    return [...profileOverrides, ...inheritedSpecialists].filter((s) => !s.enabled).length
  }, [isGlobal, visibleSpecialists, profileOverrides, inheritedSpecialists])

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
        label="Delegation Configuration"
        description={isCollab
          ? 'Configure task instructions and custom specialists shared across collaboration channels.'
          : 'Configure how managers delegate work. Global task instructions and custom specialists are shared across all projects.'}
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

      {!isCollab && (
        <SettingsSection
          label="Worker Rosters"
          description="Define the execution profiles available for delegated work. Projects and sessions can select a roster without changing its definition."
        >
          <DelegationRosterSettingsView
            clientOrWsUrl={clientOrWsUrl}
            modelPresets={modelPresets}
            selectableModels={selectableModels}
            refreshKey={modelConfigChangeKey}
          />
        </SettingsSection>
      )}

      {/* ============================================================ */}
      {/*  Category Defaults View                                       */}
      {/* ============================================================ */}
      {isCategory && selectedCategory && (
        <div>
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
        <div>
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
        <div>
        <SettingsSection
          label={isCollab ? 'Collaboration Task Instructions & Custom Specialists' : 'Task Instructions & Custom Specialists'}
          description={isCollab
            ? 'Shared task-instruction prompts and custom specialist definitions available to collaboration channels.'
            : 'Builtin task-instruction prompts and custom specialist definitions inherited by all projects. Builtins are editable but cannot be deleted.'}
          cta={headerButtons}
        >
          {newFormElement}

          {filteredGlobalSpecialists.length === 0 && !showNewForm ? (
            <p className="py-3 text-sm text-muted-foreground/70 italic">
              {hideDisabled && visibleSpecialists.length > 0
                ? `All ${visibleSpecialists.length} specialist${visibleSpecialists.length === 1 ? '' : 's'} hidden by filter.`
                : 'No task instructions or custom specialists found.'}
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
                  onClone={getBehaviorModeCardMetadata(spec.specialistId) ? undefined : () => handleClone(spec)}
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
        <div>
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
                    onClone={getBehaviorModeCardMetadata(spec.specialistId) ? undefined : () => handleClone(spec)}
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
                    onClone={getBehaviorModeCardMetadata(spec.specialistId) ? undefined : () => handleClone(spec)}
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

      {!loading && !error && !isCategory && systemSpecialists.length > 0 && (
        <SettingsSection
          label="System & Compatibility"
          description="Retained legacy and system-managed definitions. They are not offered as normal task types, but remain configurable so existing customizations are not stranded."
        >
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Show {systemSpecialists.length} system definition{systemSpecialists.length === 1 ? '' : 's'}
            </summary>
            <div className="mt-3 space-y-2">
              {systemSpecialists.map(renderSystemSpecialistCard)}
            </div>
          </details>
        </SettingsSection>
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
