import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Eye, Loader2, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsSection } from './settings-row'
import { SpecialistBadge } from '@/components/chat/SpecialistBadge'
import {
  fetchSpecialists,
  fetchSharedSpecialists,
  fetchRosterPrompt,
  fetchWorkerTemplate,
  saveSpecialist,
  saveSharedSpecialist,
  deleteSpecialist,
  deleteSharedSpecialist as deleteSharedSpecialistApi,
  type SaveSpecialistPayload,
} from './specialists-api'
import type {
  ManagerProfile,
  ManagerReasoningLevel,
  ModelPresetInfo,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'
import { MANAGER_REASONING_LEVELS } from '@forge/protocol'
import {
  getAllSelectableModels,
  getModelDisplayLabel,
  getSupportedReasoningLevelsForModelId,
  useModelPresets,
} from '@/lib/model-preset'
import type { SelectableModel } from '@/lib/model-preset'

const REASONING_LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

const SCOPE_GLOBAL = 'global' as const

const SPECIALIST_COLORS = [
  '#2563eb', // blue
  '#7c3aed', // violet
  '#059669', // emerald
  '#d97706', // amber
  '#dc2626', // red
  '#0891b2', // cyan
  '#c026d3', // fuchsia
  '#65a30d', // lime
]

const DEFAULT_WHEN_TO_USE = 'General-purpose worker for implementation tasks.'
const DEFAULT_MODEL_ID = 'gpt-5.3-codex'
const DEFAULT_REASONING_LEVEL: ManagerReasoningLevel = 'xhigh'

/** Human-friendly provider labels for Select group headers. */
const PROVIDER_LABELS: Record<string, string> = {
  'openai-codex': 'OpenAI Codex',
  'anthropic': 'Anthropic',
  'openai-codex-app-server': 'Codex App',
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

interface SettingsSpecialistsProps {
  wsUrl: string
  profiles: ManagerProfile[]
  specialistChangeKey: number
}

function isManagerReasoningLevel(value: string): value is ManagerReasoningLevel {
  return MANAGER_REASONING_LEVELS.includes(value as ManagerReasoningLevel)
}

interface CardEditState {
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId: string
  reasoningLevel: string
  fallbackModelId: string
  fallbackReasoningLevel: string
  promptBody: string
}

function specialistToEditState(
  specialist: ResolvedSpecialistDefinition,
): CardEditState {
  return {
    displayName: specialist.displayName,
    color: specialist.color,
    enabled: specialist.enabled,
    whenToUse: specialist.whenToUse,
    modelId: specialist.modelId,
    reasoningLevel: specialist.reasoningLevel ?? 'high',
    fallbackModelId: specialist.fallbackModelId ?? '',
    fallbackReasoningLevel: specialist.fallbackReasoningLevel ?? '',
    promptBody: specialist.promptBody,
  }
}

function toSaveSpecialistPayload(state: CardEditState): SaveSpecialistPayload {
  const reasoningLevel = state.reasoningLevel.trim()
  if (reasoningLevel && !isManagerReasoningLevel(reasoningLevel)) {
    throw new Error(`Reasoning level is invalid: ${reasoningLevel}`)
  }

  const normalizedReasoningLevel = reasoningLevel
    ? (reasoningLevel as ManagerReasoningLevel)
    : undefined

  const fallbackReasoningLevel = state.fallbackReasoningLevel.trim()
  if (fallbackReasoningLevel && !isManagerReasoningLevel(fallbackReasoningLevel)) {
    throw new Error(`Fallback reasoning level is invalid: ${fallbackReasoningLevel}`)
  }

  const normalizedFallbackReasoningLevel = fallbackReasoningLevel
    ? (fallbackReasoningLevel as ManagerReasoningLevel)
    : undefined

  const normalizedFallbackModelId = state.fallbackModelId || undefined

  return {
    displayName: state.displayName,
    color: state.color,
    enabled: state.enabled,
    whenToUse: state.whenToUse,
    modelId: state.modelId,
    reasoningLevel: normalizedReasoningLevel,
    fallbackModelId: normalizedFallbackModelId,
    // Strip fallback reasoning level when there's no fallback model.
    fallbackReasoningLevel: normalizedFallbackModelId ? normalizedFallbackReasoningLevel : undefined,
    promptBody: state.promptBody,
  }
}

/** Normalize a raw string into a kebab-case handle. */
function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Pick the first color not already used by any existing specialist. */
function pickAvailableColor(existingSpecialists: ResolvedSpecialistDefinition[]): string {
  const usedColors = new Set(existingSpecialists.map((s) => s.color.toLowerCase()))
  for (const color of SPECIALIST_COLORS) {
    if (!usedColors.has(color.toLowerCase())) return color
  }
  // All taken — cycle back to first
  return SPECIALIST_COLORS[0]
}

/** Derive display name from handle: kebab-case → Title Case */
function handleToDisplayName(handle: string): string {
  return handle
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Group selectable models by provider for use in Select dropdowns.
 * Returns entries ordered by first occurrence in the flat list.
 */
function groupModelsByProvider(
  models: SelectableModel[],
): Array<{ provider: string; label: string; models: SelectableModel[] }> {
  const groups = new Map<string, SelectableModel[]>()
  for (const m of models) {
    let group = groups.get(m.provider)
    if (!group) {
      group = []
      groups.set(m.provider, group)
    }
    group.push(m)
  }
  return Array.from(groups.entries()).map(([provider, items]) => ({
    provider,
    label: providerLabel(provider),
    models: items,
  }))
}

/* ================================================================== */
/*  Grouped Model Select component                                     */
/* ================================================================== */

function ModelIdSelect({
  value,
  onValueChange,
  models,
  presets,
  placeholder,
  allowNone,
}: {
  value: string
  onValueChange: (value: string) => void
  models: SelectableModel[]
  presets: ModelPresetInfo[]
  placeholder?: string
  allowNone?: boolean
}) {
  const groups = useMemo(() => groupModelsByProvider(models), [models])

  // Build a mapping from value -> display label for the trigger.
  // Radix Select matches the selected value against SelectItem children to compute
  // the trigger display text.  When our items render plain strings this works, but
  // sentinel values like "__none__" need the mapping too.
  const itemTextByValue = useMemo(() => {
    const map = new Map<string, string>()
    if (allowNone) map.set('__none__', placeholder ?? 'None')
    for (const g of groups) {
      for (const m of g.models) {
        map.set(m.modelId, m.label)
      }
    }
    return map
  }, [groups, allowNone, placeholder])

  // Controlled value: for allowNone mode use a sentinel so Radix always has a value.
  const controlledValue = allowNone ? (value || '__none__') : value

  return (
    <Select
      key={allowNone ? 'fallback' : 'primary'}
      value={controlledValue || undefined}
      onValueChange={onValueChange}
    >
      <SelectTrigger className="w-full text-xs">
        <span className="truncate">
          {controlledValue ? (itemTextByValue.get(controlledValue) ?? getModelDisplayLabel(controlledValue, presets)) : (placeholder ?? 'Select model')}
        </span>
      </SelectTrigger>
      <SelectContent position="popper">
        {allowNone && (
          <SelectItem value="__none__" className="text-xs">
            <span className="text-muted-foreground">None</span>
          </SelectItem>
        )}
        {groups.map((group) => (
          <SelectGroup key={group.provider}>
            <SelectLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">{group.label}</SelectLabel>
            {group.models.map((m) => (
              <SelectItem key={m.modelId} value={m.modelId} className="text-xs">
                {m.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

/* ================================================================== */
/*  Main component                                                     */
/* ================================================================== */

export function SettingsSpecialists({ wsUrl, profiles, specialistChangeKey }: SettingsSpecialistsProps) {
  const [selectedScope, setSelectedScope] = useState<string>(SCOPE_GLOBAL)
  const isGlobal = selectedScope === SCOPE_GLOBAL

  const modelPresets = useModelPresets(wsUrl)
  const selectableModels = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])

  const [specialists, setSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRequestIdRef = useRef(0)
  const rosterRequestIdRef = useRef(0)

  // Per-card edit states, keyed by specialistId
  const [editStates, setEditStates] = useState<Record<string, CardEditState>>({})
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set())
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(new Set())
  const [expandedFallbackIds, setExpandedFallbackIds] = useState<Set<string>>(new Set())
  const [customizeInitiatedIds, setCustomizeInitiatedIds] = useState<Set<string>>(new Set())

  // Roster prompt dialog
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterMarkdown, setRosterMarkdown] = useState('')
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)

  // New specialist creation form
  const [showNewForm, setShowNewForm] = useState(false)
  const [newHandle, setNewHandle] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newHandleDerived, setNewHandleDerived] = useState(true) // auto-derive display name until user edits it
  const [newCreating, setNewCreating] = useState(false)
  const [newError, setNewError] = useState<string | null>(null)

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
    loadRequestIdRef.current += 1
    rosterRequestIdRef.current += 1
    setSpecialists([])
    setLoading(true)
    setError(null)
    setRosterLoading(false)
    setRosterMarkdown('')
    setRosterError(null)
    setShowNewForm(false)
    resetNewForm()
  }, [selectedScope])

  const loadSpecialists = useCallback(async (): Promise<ResolvedSpecialistDefinition[]> => {
    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)

    try {
      const data = isGlobal
        ? await fetchSharedSpecialists(wsUrl)
        : await fetchSpecialists(wsUrl, selectedScope)
      if (requestId === loadRequestIdRef.current) {
        setSpecialists(data)
      }
      return data
    } catch (err) {
      if (requestId === loadRequestIdRef.current) {
        setSpecialists([])
        setError(err instanceof Error ? err.message : 'Failed to load specialists')
      }
      return []
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [wsUrl, selectedScope, isGlobal])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists, specialistChangeKey])

  useEffect(() => {
    setEditingIds(new Set())
    setEditStates({})
    setCardErrors({})
    setExpandedPromptIds(new Set())
    setExpandedFallbackIds(new Set())
    setCustomizeInitiatedIds(new Set())
  }, [selectedScope])

  /* ---- Card editing ---- */

  const startEditing = useCallback((s: ResolvedSpecialistDefinition) => {
    setEditStates((prev) => ({ ...prev, [s.specialistId]: specialistToEditState(s) }))
    setEditingIds((prev) => new Set(prev).add(s.specialistId))
    setCardErrors(({ [s.specialistId]: _, ...rest }) => rest)
  }, [])

  const cancelEditing = useCallback((id: string) => {
    setEditingIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    setEditStates(({ [id]: _, ...rest }) => rest)
    setCardErrors(({ [id]: _, ...rest }) => rest)
    setExpandedFallbackIds((prev) => { const next = new Set(prev); next.delete(id); return next })
  }, [])

  const updateEditField = useCallback((id: string, field: keyof CardEditState, value: string | boolean) => {
    setEditStates((prev) => {
      const currentState = prev[id]
      if (!currentState) {
        return prev
      }

      const nextState: CardEditState = { ...currentState, [field]: value }

      // Auto-normalize reasoning level when model changes
      if (field === 'modelId' && typeof value === 'string') {
        const supported = getSupportedReasoningLevelsForModelId(value, modelPresets)
        if (!supported.includes(nextState.reasoningLevel as ManagerReasoningLevel)) {
          nextState.reasoningLevel = supported[supported.length - 1] || 'high'
        }
      }

      // Auto-normalize fallback reasoning level when fallback model changes
      if (field === 'fallbackModelId' && typeof value === 'string' && value) {
        const supported = getSupportedReasoningLevelsForModelId(value, modelPresets)
        if (nextState.fallbackReasoningLevel && !supported.includes(nextState.fallbackReasoningLevel as ManagerReasoningLevel)) {
          nextState.fallbackReasoningLevel = supported[supported.length - 1] || 'high'
        }
      }

      return {
        ...prev,
        [id]: nextState,
      }
    })
  }, [modelPresets])

  /** Wraps an async card action with saving-state tracking and error capture. */
  const withCardAction = useCallback(async (id: string, action: () => Promise<void>, errorLabel: string) => {
    setSavingIds((prev) => new Set(prev).add(id))
    setCardErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await action()
    } catch (err) {
      setCardErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : errorLabel,
      }))
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  const handleSave = useCallback(async (id: string) => {
    const state = editStates[id]
    if (!state) return
    await withCardAction(id, async () => {
      const payload = toSaveSpecialistPayload(state)
      if (isGlobal) {
        await saveSharedSpecialist(wsUrl, id, payload)
      } else {
        await saveSpecialist(wsUrl, selectedScope, id, payload)
      }
      setCustomizeInitiatedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
      cancelEditing(id)
      await loadSpecialists()
    }, 'Save failed')
  }, [editStates, wsUrl, selectedScope, isGlobal, cancelEditing, loadSpecialists, withCardAction])

  const handleCreateOverride = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload(specialistToEditState(s))
      await saveSpecialist(wsUrl, selectedScope, s.specialistId, payload)
      setCustomizeInitiatedIds((prev) => new Set(prev).add(s.specialistId))
      const updatedSpecialists = await loadSpecialists()
      const updated = updatedSpecialists.find((sp) => sp.specialistId === s.specialistId)
      if (updated) startEditing(updated)
    }, 'Failed to create override')
  }, [wsUrl, selectedScope, loadSpecialists, startEditing, withCardAction])

  /** Toggle enabled on an inherited specialist — creates override automatically. */
  const handleInheritedToggleEnabled = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload({
        ...specialistToEditState(s),
        enabled: !s.enabled,
      })
      await saveSpecialist(wsUrl, selectedScope, s.specialistId, payload)
      await loadSpecialists()
    }, 'Failed to toggle')
  }, [wsUrl, selectedScope, loadSpecialists, withCardAction])

  const handleCancelProfileEditing = useCallback(async (id: string) => {
    const wasCustomizeInitiated = customizeInitiatedIds.has(id)
    cancelEditing(id)

    if (wasCustomizeInitiated) {
      setCustomizeInitiatedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
      try {
        await deleteSpecialist(wsUrl, selectedScope, id)
      } catch {
        // Best effort
      }
      await loadSpecialists()
    }
  }, [customizeInitiatedIds, cancelEditing, wsUrl, selectedScope, loadSpecialists])

  const handleRevert = useCallback(async (id: string) => {
    await withCardAction(id, async () => {
      await deleteSpecialist(wsUrl, selectedScope, id)
      cancelEditing(id)
      await loadSpecialists()
    }, 'Revert failed')
  }, [wsUrl, selectedScope, cancelEditing, loadSpecialists, withCardAction])

  const handleDelete = useCallback(async (id: string) => {
    await withCardAction(id, async () => {
      if (isGlobal) {
        await deleteSharedSpecialistApi(wsUrl, id)
      } else {
        await deleteSpecialist(wsUrl, selectedScope, id)
      }
      cancelEditing(id)
      await loadSpecialists()
    }, 'Delete failed')
  }, [wsUrl, selectedScope, isGlobal, cancelEditing, loadSpecialists, withCardAction])

  const togglePromptExpand = useCallback((id: string) => {
    setExpandedPromptIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleFallbackExpand = useCallback((id: string) => {
    setExpandedFallbackIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /* ---- Roster prompt ---- */

  const handleViewRoster = useCallback(async () => {
    if (isGlobal) return

    const requestId = ++rosterRequestIdRef.current
    setRosterOpen(true)
    setRosterLoading(true)
    setRosterError(null)

    try {
      const markdown = await fetchRosterPrompt(wsUrl, selectedScope)
      if (requestId === rosterRequestIdRef.current) {
        setRosterMarkdown(markdown)
      }
    } catch (err) {
      if (requestId === rosterRequestIdRef.current) {
        setRosterMarkdown('')
        setRosterError(err instanceof Error ? err.message : 'Failed to load roster prompt')
      }
    } finally {
      if (requestId === rosterRequestIdRef.current) {
        setRosterLoading(false)
      }
    }
  }, [wsUrl, selectedScope, isGlobal])

  /* ---- New specialist creation ---- */

  function resetNewForm() {
    setNewHandle('')
    setNewDisplayName('')
    setNewHandleDerived(true)
    setNewCreating(false)
    setNewError(null)
  }

  const normalizedNewHandle = normalizeHandle(newHandle)
  const handleConflict = normalizedNewHandle
    ? specialists.some((s) => s.specialistId === normalizedNewHandle)
    : false

  const newHandleValid = normalizedNewHandle.length > 0 && !handleConflict

  const handleNewHandleChange = useCallback((raw: string) => {
    setNewHandle(raw)
    setNewError(null)
    if (newHandleDerived) {
      const normalized = normalizeHandle(raw)
      setNewDisplayName(normalized ? handleToDisplayName(normalized) : '')
    }
  }, [newHandleDerived])

  const handleNewDisplayNameChange = useCallback((value: string) => {
    setNewDisplayName(value)
    setNewHandleDerived(false)
  }, [])

  const handleCancelNew = useCallback(() => {
    setShowNewForm(false)
    resetNewForm()
  }, [])

  const handleCreateNew = useCallback(async () => {
    if (!newHandleValid) return
    setNewCreating(true)
    setNewError(null)

    try {
      // Fetch worker template for system prompt
      let template: string
      try {
        template = await fetchWorkerTemplate(wsUrl)
      } catch {
        template = [
          'You are a worker agent in a swarm.',
          '- You can list agents and send messages to other agents.',
          '- Use coding tools (read/bash/edit/write) to execute implementation tasks.',
          '- Report progress and outcomes back to the manager using send_message_to_agent.',
          '- You are not user-facing.',
        ].join('\n')
      }

      const displayName = newDisplayName.trim() || handleToDisplayName(normalizedNewHandle)
      const color = pickAvailableColor(specialists)

      const payload: SaveSpecialistPayload = {
        displayName,
        color,
        enabled: true,
        whenToUse: DEFAULT_WHEN_TO_USE,
        modelId: DEFAULT_MODEL_ID,
        reasoningLevel: DEFAULT_REASONING_LEVEL,
        promptBody: template,
      }

      if (isGlobal) {
        await saveSharedSpecialist(wsUrl, normalizedNewHandle, payload)
      } else {
        await saveSpecialist(wsUrl, selectedScope, normalizedNewHandle, payload)
      }

      const updatedSpecialists = await loadSpecialists()
      setShowNewForm(false)
      resetNewForm()

      // Open the new card in edit mode
      const created = updatedSpecialists.find((s) => s.specialistId === normalizedNewHandle)
      if (created) {
        startEditing(created)
        setExpandedPromptIds((prev) => new Set(prev).add(created.specialistId))
      }
    } catch (err) {
      setNewError(err instanceof Error ? err.message : 'Failed to create specialist')
    } finally {
      setNewCreating(false)
    }
  }, [
    wsUrl,
    selectedScope,
    isGlobal,
    normalizedNewHandle,
    newDisplayName,
    newHandleValid,
    specialists,
    loadSpecialists,
    startEditing,
  ])

  /* ---- Derived lists ---- */

  const { profileOverrides, inheritedSpecialists } = useMemo(() => {
    const sorted = [...specialists].sort((a, b) => a.specialistId.localeCompare(b.specialistId))
    return {
      profileOverrides: sorted.filter((s) => s.sourceKind === 'profile'),
      inheritedSpecialists: sorted.filter((s) => s.sourceKind !== 'profile'),
    }
  }, [specialists])

  /* ---- Render ---- */

  const headerButtons = (
    <div className="flex items-center gap-2">
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
        <SettingsSection
          label="Global Specialists"
          description="Shared specialist definitions inherited by all profiles. Builtins are editable but cannot be deleted."
          cta={headerButtons}
        >
          {/* New specialist inline form */}
          {showNewForm && (
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
          )}

          {specialists.length === 0 && !showNewForm ? (
            <p className="py-3 text-sm text-muted-foreground/70 italic">
              No global specialists found.
            </p>
          ) : (
            specialists.map((spec) => (
              <GlobalSpecialistCard
                key={spec.specialistId}
                specialist={spec}
                isEditing={editingIds.has(spec.specialistId)}
                editState={editStates[spec.specialistId]}
                isSaving={savingIds.has(spec.specialistId)}
                cardError={cardErrors[spec.specialistId]}
                isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
                isFallbackExpanded={expandedFallbackIds.has(spec.specialistId)}
                onStartEditing={() => startEditing(spec)}
                onCancelEditing={() => cancelEditing(spec.specialistId)}
                onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
                onSave={() => handleSave(spec.specialistId)}
                onDelete={() => handleDelete(spec.specialistId)}
                onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
                onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
                modelPresets={modelPresets}
                selectableModels={selectableModels}
              />
            ))
          )}
        </SettingsSection>
      )}

      {!loading && !error && !isGlobal && (
        <>
          {/* ============================================================ */}
          {/*  Profile View — Overrides                                     */}
          {/* ============================================================ */}
          <SettingsSection
            label="Profile Customizations"
            description="Specialists customized for this profile. These take priority over inherited defaults."
            cta={headerButtons}
          >
            {/* New specialist inline form */}
            {showNewForm && (
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
            )}

            {profileOverrides.length === 0 && !showNewForm ? (
              <p className="py-3 text-sm text-muted-foreground/70 italic">
                No profile customizations. Override a specialist below to customize it for this profile.
              </p>
            ) : (
              profileOverrides.map((spec) => (
                <ProfileOverrideCard
                  key={spec.specialistId}
                  specialist={spec}
                  isEditing={editingIds.has(spec.specialistId)}
                  editState={editStates[spec.specialistId]}
                  isSaving={savingIds.has(spec.specialistId)}
                  cardError={cardErrors[spec.specialistId]}
                  isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
                  isFallbackExpanded={expandedFallbackIds.has(spec.specialistId)}
                  onStartEditing={() => startEditing(spec)}
                  onCancelEditing={() => handleCancelProfileEditing(spec.specialistId)}
                  onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
                  onSave={() => handleSave(spec.specialistId)}
                  onRevert={() => handleRevert(spec.specialistId)}
                  onDelete={() => handleDelete(spec.specialistId)}
                  onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
                  onToggleFallback={() => toggleFallbackExpand(spec.specialistId)}
                  modelPresets={modelPresets}
                  selectableModels={selectableModels}
                />
              ))
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
              <div className="space-y-2">
                {inheritedSpecialists.map((spec) => (
                  <InheritedSpecialistCard
                    key={spec.specialistId}
                    specialist={spec}
                    isSaving={savingIds.has(spec.specialistId)}
                    cardError={cardErrors[spec.specialistId]}
                    onCreateOverride={() => handleCreateOverride(spec)}
                    onToggleEnabled={() => handleInheritedToggleEnabled(spec)}
                    modelPresets={modelPresets}
                  />
                ))}
              </div>
            </SettingsSection>
          )}
        </>
      )}

      {/* Roster prompt dialog */}
      <Dialog open={rosterOpen} onOpenChange={setRosterOpen}>
        <DialogContent className="!max-w-3xl max-h-[80vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Generated Roster Prompt</DialogTitle>
            <DialogDescription>
              This is the specialist roster block injected into the manager system prompt.
            </DialogDescription>
          </DialogHeader>
          {rosterLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : rosterError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{rosterError}</p>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/50 p-3">
              <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
                {rosterMarkdown || '(empty)'}
              </pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  New Specialist Inline Form                                         */
/* ------------------------------------------------------------------ */

function NewSpecialistForm({
  handle,
  displayName,
  normalizedHandle,
  handleConflict,
  isValid,
  isCreating,
  error,
  onHandleChange,
  onDisplayNameChange,
  onCreate,
  onCancel,
}: {
  handle: string
  displayName: string
  normalizedHandle: string
  handleConflict: boolean
  isValid: boolean
  isCreating: boolean
  error: string | null
  onHandleChange: (value: string) => void
  onDisplayNameChange: (value: string) => void
  onCreate: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-4 space-y-3">
      <p className="text-xs font-medium text-foreground">Create New Specialist</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Handle</Label>
          <Input
            value={handle}
            onChange={(e) => onHandleChange(e.target.value)}
            placeholder="my-specialist"
            className="h-9 text-sm font-mono"
            disabled={isCreating}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid && !isCreating) onCreate()
              if (e.key === 'Escape') onCancel()
            }}
          />
          {normalizedHandle && normalizedHandle !== handle.trim() && (
            <p className="text-[11px] text-muted-foreground">
              → <span className="font-mono">{normalizedHandle}</span>
            </p>
          )}
          {handleConflict && (
            <p className="text-[11px] text-destructive">
              A specialist with this handle already exists.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Display name</Label>
          <Input
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="My Specialist"
            className="h-9 text-sm"
            disabled={isCreating}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid && !isCreating) onCreate()
              if (e.key === 'Escape') onCancel()
            }}
          />
        </div>
      </div>
      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onCreate} disabled={!isValid || isCreating} className="gap-1">
          {isCreating && <Loader2 className="size-3 animate-spin" />}
          Create
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isCreating}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Fallback Model Section                                             */
/* ------------------------------------------------------------------ */

function FallbackModelSection({
  isEditing,
  isExpanded,
  onToggle,
  fallbackModelId,
  fallbackReasoningLevel,
  onUpdateField,
  modelPresets,
  selectableModels,
}: {
  isEditing: boolean
  isExpanded: boolean
  onToggle: () => void
  fallbackModelId: string
  fallbackReasoningLevel: string
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
}) {
  const hasFallback = !!fallbackModelId

  if (!isEditing) {
    // Read-only: show compact summary if configured
    if (!hasFallback) return null
    const label = getModelDisplayLabel(fallbackModelId, modelPresets)
    const reasoningLabel = fallbackReasoningLevel
      ? REASONING_LEVEL_LABELS[fallbackReasoningLevel] ?? fallbackReasoningLevel
      : null
    return (
      <p className="text-xs text-muted-foreground">
        Fallback: {label}
        {reasoningLabel && <span className="mx-1.5 text-muted-foreground/40">·</span>}
        {reasoningLabel}
      </p>
    )
  }

  // Editing mode
  const fallbackSupportedLevels = fallbackModelId
    ? getSupportedReasoningLevelsForModelId(fallbackModelId, modelPresets)
    : [...MANAGER_REASONING_LEVELS]

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={isExpanded}
      >
        {isExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        {hasFallback
          ? `Fallback: ${getModelDisplayLabel(fallbackModelId, modelPresets)}${fallbackReasoningLevel ? ` · ${REASONING_LEVEL_LABELS[fallbackReasoningLevel] ?? fallbackReasoningLevel}` : ''}`
          : 'Configure fallback'}
      </button>

      {isExpanded && (
        <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 p-3 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-1.5 sm:w-52">
            <Label className="text-xs font-medium text-muted-foreground">Fallback model</Label>
            <ModelIdSelect
              value={fallbackModelId}
              onValueChange={(v) => onUpdateField('fallbackModelId', v === '__none__' ? '' : v)}
              models={selectableModels}
              presets={modelPresets}
              placeholder="None"
              allowNone
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:w-40">
            <Label className="text-xs font-medium text-muted-foreground">Fallback reasoning</Label>
            <Select
              value={fallbackReasoningLevel || '__use_primary__'}
              onValueChange={(v) => onUpdateField('fallbackReasoningLevel', v === '__use_primary__' ? '' : v)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__use_primary__" className="text-xs">
                  <span className="text-muted-foreground">Use primary</span>
                </SelectItem>
                {fallbackSupportedLevels.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {REASONING_LEVEL_LABELS[level] || level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared editable card props                                         */
/* ------------------------------------------------------------------ */

interface EditableCardProps {
  specialist: ResolvedSpecialistDefinition
  isEditing: boolean
  editState: CardEditState | undefined
  isSaving: boolean
  cardError?: string
  isPromptExpanded: boolean
  isFallbackExpanded: boolean
  onStartEditing: () => void
  onCancelEditing: () => void
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  onSave: () => void
  onTogglePrompt: () => void
  onToggleFallback: () => void
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
}

/* ------------------------------------------------------------------ */
/*  Shared model/reasoning editing section                             */
/* ------------------------------------------------------------------ */

function ModelReasoningSection({
  isEditing,
  currentValues,
  specialist,
  onUpdateField,
  modelPresets,
  selectableModels,
}: {
  isEditing: boolean
  currentValues: CardEditState
  specialist: ResolvedSpecialistDefinition
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
}) {
  const modelDisplay = getModelDisplayLabel(specialist.modelId, modelPresets)
  const displayReasoningLevel = specialist.reasoningLevel ?? 'high'

  const supportedLevels = getSupportedReasoningLevelsForModelId(currentValues.modelId, modelPresets)

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex flex-col gap-1.5 sm:w-52">
        <Label className="text-xs font-medium text-muted-foreground">Model</Label>
        {isEditing ? (
          <ModelIdSelect
            value={currentValues.modelId}
            onValueChange={(v) => onUpdateField('modelId', v)}
            models={selectableModels}
            presets={modelPresets}
            placeholder="Select model"
          />
        ) : (
          <span className="text-xs text-foreground/80">{modelDisplay}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 sm:w-40">
        <Label className="text-xs font-medium text-muted-foreground">Reasoning level</Label>
        {isEditing ? (
          <Select
            value={currentValues.reasoningLevel}
            onValueChange={(value) => onUpdateField('reasoningLevel', value)}
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
        ) : (
          <span className="text-xs text-foreground/80">
            {REASONING_LEVEL_LABELS[displayReasoningLevel] ?? displayReasoningLevel}
          </span>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Global Specialist Card — full editable card                        */
/* ------------------------------------------------------------------ */

function GlobalSpecialistCard({
  specialist,
  isEditing,
  editState,
  isSaving,
  cardError,
  isPromptExpanded,
  isFallbackExpanded,
  onStartEditing,
  onCancelEditing,
  onUpdateField,
  onSave,
  onDelete,
  onTogglePrompt,
  onToggleFallback,
  modelPresets,
  selectableModels,
}: EditableCardProps & {
  onDelete: () => void
}) {
  const currentValues = isEditing && editState ? editState : specialistToEditState(specialist)
  const promptLineCount = currentValues.promptBody.split('\n').length

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SpecialistBadge displayName={currentValues.displayName} color={currentValues.color} />
            <span className="font-mono text-xs text-muted-foreground">{specialist.specialistId}.md</span>
            {specialist.builtin && (
              <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Builtin
              </span>
            )}
            {!specialist.available && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" />
                {specialist.availabilityMessage || 'Unavailable'}
              </span>
            )}
          </div>
          {!isEditing && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Display name: <span className="text-foreground/80">{specialist.displayName}</span>
              </p>
              <p>
                Badge color: <span className="font-mono text-foreground/80">{specialist.color}</span>
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 self-start">
          <Label className="text-xs font-medium text-muted-foreground" htmlFor={`enabled-${specialist.specialistId}`}>
            Enabled
          </Label>
          <Switch
            id={`enabled-${specialist.specialistId}`}
            size="sm"
            checked={isEditing ? currentValues.enabled : specialist.enabled}
            disabled={!isEditing || isSaving}
            onCheckedChange={(checked) => onUpdateField('enabled', checked)}
            aria-label={`Toggle ${specialist.specialistId} specialist`}
          />
        </div>
      </div>

      {isEditing && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Display name</Label>
            <Input
              value={currentValues.displayName}
              onChange={(e) => onUpdateField('displayName', e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Badge color</Label>
            <div className="flex items-center gap-2">
              <Input
                value={currentValues.color}
                onChange={(e) => onUpdateField('color', e.target.value)}
                className="h-9 font-mono text-sm"
                placeholder="#2563eb"
              />
              <span
                className="size-6 shrink-0 rounded border"
                style={{ backgroundColor: currentValues.color }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">When to use</Label>
        {isEditing ? (
          <Textarea
            value={currentValues.whenToUse}
            onChange={(e) => onUpdateField('whenToUse', e.target.value)}
            rows={2}
            className="resize-none text-xs"
          />
        ) : (
          <p className="text-xs text-foreground/80">{specialist.whenToUse}</p>
        )}
      </div>

      <ModelReasoningSection
        isEditing={isEditing}
        currentValues={currentValues}
        specialist={specialist}
        onUpdateField={onUpdateField}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
      />

      <FallbackModelSection
        isEditing={isEditing}
        isExpanded={isFallbackExpanded}
        onToggle={onToggleFallback}
        fallbackModelId={currentValues.fallbackModelId}
        fallbackReasoningLevel={currentValues.fallbackReasoningLevel}
        onUpdateField={onUpdateField}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
      />

      <div className="space-y-1">
        <button
          type="button"
          onClick={onTogglePrompt}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isPromptExpanded}
        >
          {isPromptExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          System prompt
          <span className="text-[10px] text-muted-foreground/60">({promptLineCount} lines)</span>
        </button>
        {isPromptExpanded && (
          isEditing ? (
            <Textarea
              value={currentValues.promptBody}
              onChange={(e) => onUpdateField('promptBody', e.target.value)}
              rows={12}
              className="resize-y font-mono text-xs"
            />
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {specialist.promptBody}
              </pre>
            </div>
          )
        )}
      </div>

      {cardError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{cardError}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {isEditing ? (
          <>
            <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-1">
              {isSaving && <Loader2 className="size-3 animate-spin" />}
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelEditing} disabled={isSaving}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onStartEditing} disabled={isSaving}>
              Edit
            </Button>
            {!specialist.builtin && (
              <Button
                size="sm"
                variant="outline"
                onClick={onDelete}
                disabled={isSaving}
                className="gap-1 text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3" />
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Profile Override Card — full editable card                         */
/* ------------------------------------------------------------------ */

function ProfileOverrideCard({
  specialist,
  isEditing,
  editState,
  isSaving,
  cardError,
  isPromptExpanded,
  isFallbackExpanded,
  onStartEditing,
  onCancelEditing,
  onUpdateField,
  onSave,
  onRevert,
  onDelete,
  onTogglePrompt,
  onToggleFallback,
  modelPresets,
  selectableModels,
}: EditableCardProps & {
  onRevert: () => void
  onDelete: () => void
}) {
  const currentValues = isEditing && editState ? editState : specialistToEditState(specialist)
  const promptLineCount = currentValues.promptBody.split('\n').length

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SpecialistBadge displayName={currentValues.displayName} color={currentValues.color} />
            <span className="font-mono text-xs text-muted-foreground">{specialist.specialistId}.md</span>
            {!specialist.available ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" />
                {specialist.availabilityMessage || 'Unavailable'}
              </span>
            ) : null}
          </div>
          {!isEditing ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Display name: <span className="text-foreground/80">{specialist.displayName}</span>
              </p>
              <p>
                Badge color: <span className="font-mono text-foreground/80">{specialist.color}</span>
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 self-start">
          <Label className="text-xs font-medium text-muted-foreground" htmlFor={`enabled-${specialist.specialistId}`}>
            Enabled
          </Label>
          <Switch
            id={`enabled-${specialist.specialistId}`}
            size="sm"
            checked={isEditing ? currentValues.enabled : specialist.enabled}
            disabled={!isEditing || isSaving}
            onCheckedChange={(checked) => onUpdateField('enabled', checked)}
            aria-label={`Toggle ${specialist.specialistId} specialist`}
          />
        </div>
      </div>

      {isEditing ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Display name</Label>
            <Input
              value={currentValues.displayName}
              onChange={(e) => onUpdateField('displayName', e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Badge color</Label>
            <div className="flex items-center gap-2">
              <Input
                value={currentValues.color}
                onChange={(e) => onUpdateField('color', e.target.value)}
                className="h-9 font-mono text-sm"
                placeholder="#2563eb"
              />
              <span
                className="size-6 shrink-0 rounded border"
                style={{ backgroundColor: currentValues.color }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">When to use</Label>
        {isEditing ? (
          <Textarea
            value={currentValues.whenToUse}
            onChange={(e) => onUpdateField('whenToUse', e.target.value)}
            rows={2}
            className="resize-none text-xs"
          />
        ) : (
          <p className="text-xs text-foreground/80">{specialist.whenToUse}</p>
        )}
      </div>

      <ModelReasoningSection
        isEditing={isEditing}
        currentValues={currentValues}
        specialist={specialist}
        onUpdateField={onUpdateField}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
      />

      <FallbackModelSection
        isEditing={isEditing}
        isExpanded={isFallbackExpanded}
        onToggle={onToggleFallback}
        fallbackModelId={currentValues.fallbackModelId}
        fallbackReasoningLevel={currentValues.fallbackReasoningLevel}
        onUpdateField={onUpdateField}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
      />

      <div className="space-y-1">
        <button
          type="button"
          onClick={onTogglePrompt}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isPromptExpanded}
        >
          {isPromptExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          System prompt
          <span className="text-[10px] text-muted-foreground/60">({promptLineCount} lines)</span>
        </button>
        {isPromptExpanded ? (
          isEditing ? (
            <Textarea
              value={currentValues.promptBody}
              onChange={(e) => onUpdateField('promptBody', e.target.value)}
              rows={12}
              className="resize-y font-mono text-xs"
            />
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {specialist.promptBody}
              </pre>
            </div>
          )
        ) : null}
      </div>

      {cardError ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{cardError}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {isEditing ? (
          <>
            <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-1">
              {isSaving ? <Loader2 className="size-3 animate-spin" /> : null}
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelEditing} disabled={isSaving}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={onStartEditing} disabled={isSaving}>
              Edit
            </Button>
            {specialist.shadowsGlobal ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onRevert}
                disabled={isSaving}
                className="gap-1 text-muted-foreground"
              >
                <RotateCcw className="size-3" />
                Revert to default
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={onDelete}
                disabled={isSaving}
                className="gap-1 text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3" />
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inherited Specialist Card — compact read-only                      */
/* ------------------------------------------------------------------ */

function InheritedSpecialistCard({
  specialist,
  isSaving,
  cardError,
  onCreateOverride,
  onToggleEnabled,
  modelPresets,
}: {
  specialist: ResolvedSpecialistDefinition
  isSaving: boolean
  cardError?: string
  onCreateOverride: () => void
  onToggleEnabled: () => void
  modelPresets: ModelPresetInfo[]
}) {
  const modelDisplay = getModelDisplayLabel(specialist.modelId, modelPresets)
  const reasoningLabel = REASONING_LEVEL_LABELS[specialist.reasoningLevel ?? 'high'] ?? specialist.reasoningLevel ?? 'High'

  const hasFallback = !!specialist.fallbackModelId
  const fallbackLabel = hasFallback
    ? getModelDisplayLabel(specialist.fallbackModelId!, modelPresets)
    : null
  const fallbackReasoningLabel = specialist.fallbackReasoningLevel
    ? REASONING_LEVEL_LABELS[specialist.fallbackReasoningLevel] ?? specialist.fallbackReasoningLevel
    : null

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 transition-colors hover:bg-muted/50">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* Left: badge, handle, model summary */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SpecialistBadge displayName={specialist.displayName} color={specialist.color} />
            <span className="font-mono text-xs text-muted-foreground/70">{specialist.specialistId}.md</span>
            {!specialist.available ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" />
                {specialist.availabilityMessage || 'Unavailable'}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <span>{modelDisplay}</span>
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            <span>{reasoningLabel}</span>
          </p>
          {hasFallback && (
            <p className="text-xs text-muted-foreground/70">
              Fallback: {fallbackLabel}
              {fallbackReasoningLabel && (
                <>
                  <span className="mx-1.5 text-muted-foreground/40">·</span>
                  {fallbackReasoningLabel}
                </>
              )}
            </p>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-3 self-start shrink-0">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground/70" htmlFor={`inherited-enabled-${specialist.specialistId}`}>
              Enabled
            </Label>
            <Switch
              id={`inherited-enabled-${specialist.specialistId}`}
              size="sm"
              checked={specialist.enabled}
              disabled={isSaving}
              onCheckedChange={onToggleEnabled}
              aria-label={`Toggle ${specialist.specialistId} specialist`}
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCreateOverride}
            disabled={isSaving}
            className="gap-1 text-xs text-muted-foreground hover:text-foreground h-7 px-2"
          >
            {isSaving ? <Loader2 className="size-3 animate-spin" /> : <Pencil className="size-3" />}
            Customize
          </Button>
        </div>
      </div>

      {/* When to use — compact single-line with truncation */}
      {specialist.whenToUse ? (
        <p className="mt-1.5 text-xs text-muted-foreground/70 line-clamp-2">
          {specialist.whenToUse}
        </p>
      ) : null}

      {cardError ? (
        <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{cardError}</p>
        </div>
      ) : null}
    </div>
  )
}
