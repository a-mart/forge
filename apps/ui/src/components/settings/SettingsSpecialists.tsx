import { useEffect, useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useHelpContext } from '@/components/help/help-hooks'
import { Eye, Loader2, Plus } from 'lucide-react'
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
import { SCOPE_GLOBAL } from './specialists/types'
import { useSpecialistsData } from './specialists/hooks/useSpecialistsData'
import { useCardEditing } from './specialists/hooks/useCardEditing'
import { useRosterPrompt } from './specialists/hooks/useRosterPrompt'
import { useNewSpecialistForm } from './specialists/hooks/useNewSpecialistForm'
import { useHideDisabled } from './specialists/hooks/useHideDisabled'
import { SpecialistCard } from './specialists/SpecialistCard'
import { NewSpecialistForm } from './specialists/NewSpecialistForm'
import { RosterPromptDialog } from './specialists/RosterPromptDialog'
import { PendingSaveDialog } from './specialists/PendingSaveDialog'

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
}: SettingsSpecialistsProps) {
  useHelpContext('settings.specialists')
  const clientOrWsUrl: import('./settings-api-client').SettingsApiClient | string = apiClient ?? wsUrl

  const [selectedScope, setSelectedScope] = useState<string>(SCOPE_GLOBAL)
  const isGlobal = selectedScope === SCOPE_GLOBAL

  const modelPresets = useModelPresets(wsUrl, modelConfigChangeKey, { allowDynamicPresetIds: true })
  const selectableModels = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])

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
  } = useSpecialistsData(clientOrWsUrl, selectedScope, isGlobal, specialistChangeKey)

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
  } = useCardEditing(clientOrWsUrl, selectedScope, isGlobal, specialists, loadSpecialists, modelPresets)

  const {
    rosterOpen,
    setRosterOpen,
    rosterMarkdown,
    rosterLoading,
    rosterError,
    handleViewRoster,
    resetRoster,
  } = useRosterPrompt(clientOrWsUrl, selectedScope, isGlobal)

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
  )

  // Ensure selected scope stays valid when profiles change
  useEffect(() => {
    setSelectedScope((prev) => {
      if (prev === SCOPE_GLOBAL) return prev
      if (profiles.some((p) => p.profileId === prev)) return prev
      return profiles.length > 0 ? profiles[0].profileId : SCOPE_GLOBAL
    })
  }, [profiles])

  // Reset transient state on scope change
  useEffect(() => {
    resetRoster()
    resetNewForm()
    resetEditing()
  }, [selectedScope, resetRoster, resetNewForm, resetEditing])

  /* ---- Derived lists ---- */

  const { profileOverrides, inheritedSpecialists } = useMemo(() => {
    const sorted = [...specialists].sort((a, b) => a.specialistId.localeCompare(b.specialistId))
    return {
      profileOverrides: sorted.filter((s) => s.sourceKind === 'profile'),
      inheritedSpecialists: sorted.filter((s) => s.sourceKind !== 'profile'),
    }
  }, [specialists])

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
      {!isGlobal && (
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
      {/* Scope selector */}
      <SettingsSection
        label="Specialist Roster"
        description="Manage specialist worker definitions. Global specialists are shared across all profiles."
      >
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Configuration scope</Label>
          <Select value={selectedScope} onValueChange={setSelectedScope}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SCOPE_GLOBAL}>Global</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.profileId} value={profile.profileId}>
                  {profile.displayName || profile.profileId}
                </SelectItem>
              ))}
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

      {/* Loading / error states */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && isGlobal && (
        /* ============================================================ */
        /*  Global View                                                  */
        /* ============================================================ */
        <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
        <SettingsSection
          label="Global Specialists"
          description="Shared specialist definitions inherited by all profiles. Builtins are editable but cannot be deleted."
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

      {!loading && !error && !isGlobal && (
        <div className={!specialistsEnabled ? 'opacity-50 pointer-events-none select-none' : undefined}>
          {/* ============================================================ */}
          {/*  Profile View — Overrides                                     */}
          {/* ============================================================ */}
          <SettingsSection
            label="Profile Customizations"
            description="Specialists customized for this profile. These take priority over inherited defaults."
            cta={headerButtons}
          >
            {newFormElement}

            {filteredProfileOverrides.length === 0 && !showNewForm ? (
              <p className="py-3 text-sm text-muted-foreground/70 italic">
                {hideDisabled && profileOverrides.length > 0
                  ? `All ${profileOverrides.length} customization${profileOverrides.length === 1 ? '' : 's'} hidden by filter.`
                  : 'No profile customizations. Override a specialist below to customize it for this profile.'}
              </p>
            ) : (
              <div className="space-y-2">
                {filteredProfileOverrides.map((spec) => (
                  <SpecialistCard
                    key={spec.specialistId}
                    mode="profileOverride"
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
          {/*  Profile View — Inherited                                     */}
          {/* ============================================================ */}
          {inheritedSpecialists.length > 0 && (
            <SettingsSection
              label="Inherited Specialists"
              description="Baseline specialists from builtin and global definitions. Customize any of these to create a profile-specific version."
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
