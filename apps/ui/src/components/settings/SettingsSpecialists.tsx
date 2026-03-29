import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useHelpContext } from '@/components/help/help-hooks'
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Eye, Loader2, Pencil, Pin, Plus, RotateCcw, Trash2 } from 'lucide-react'
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
  DialogFooter,
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
  fetchSpecialistsEnabled,
  setSpecialistsEnabledApi,
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
import { cn } from '@/lib/utils'
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
  '#f97316', // orange
  '#6b7280', // gray
  '#ec4899', // pink
  '#10b981', // green
  '#f59e0b', // yellow
]

const DEFAULT_WHEN_TO_USE = 'General-purpose worker for implementation tasks.'
const DEFAULT_MODEL_ID = 'gpt-5.3-codex'
const DEFAULT_REASONING_LEVEL: ManagerReasoningLevel = 'xhigh'

/** Human-friendly provider labels for Select group headers. */
const PROVIDER_LABELS: Record<string, string> = {
  'openai-codex': 'OpenAI Codex',
  'anthropic': 'Anthropic',
  xai: 'xAI',
  'openai-codex-app-server': 'Codex App',
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

function modelSupportsWebSearch(modelId: string, presets: ModelPresetInfo[]): boolean {
  for (const preset of presets) {
    if (preset.modelId === modelId || preset.variants?.some((variant) => variant.modelId === modelId)) {
      return preset.webSearch === true
    }
  }
  return false
}

interface SettingsSpecialistsProps {
  wsUrl: string
  profiles: ManagerProfile[]
  specialistChangeKey: number
  modelConfigChangeKey: number
}

function isManagerReasoningLevel(value: string): value is ManagerReasoningLevel {
  return MANAGER_REASONING_LEVELS.includes(value as ManagerReasoningLevel)
}

interface CardEditState {
  handle: string
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  modelId: string
  reasoningLevel: string
  fallbackModelId: string
  fallbackReasoningLevel: string
  pinned: boolean
  webSearch: boolean
  promptBody: string
}

function specialistToEditState(
  specialist: ResolvedSpecialistDefinition,
): CardEditState {
  return {
    handle: specialist.specialistId,
    displayName: specialist.displayName,
    color: specialist.color,
    enabled: specialist.enabled,
    whenToUse: specialist.whenToUse,
    modelId: specialist.modelId,
    reasoningLevel: specialist.reasoningLevel ?? 'high',
    fallbackModelId: specialist.fallbackModelId ?? '',
    fallbackReasoningLevel: specialist.fallbackReasoningLevel ?? '',
    pinned: specialist.pinned,
    webSearch: specialist.webSearch ?? false,
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
    pinned: state.pinned,
    webSearch: state.webSearch,
    promptBody: state.promptBody,
  }
}

/* ------------------------------------------------------------------ */
/*  Color Swatch Picker                                                */
/* ------------------------------------------------------------------ */

function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-6 shrink-0 rounded border cursor-pointer transition-shadow hover:ring-2 hover:ring-ring hover:ring-offset-1"
          style={{ backgroundColor: value }}
          aria-label="Pick badge color"
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="end">
        <div className="grid grid-cols-5 gap-1.5">
          {SPECIALIST_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                'size-6 rounded-full border-2 cursor-pointer transition-transform hover:scale-110',
                value.toLowerCase() === color.toLowerCase()
                  ? 'border-foreground ring-2 ring-ring ring-offset-1'
                  : 'border-transparent',
              )}
              style={{ backgroundColor: color }}
              onClick={() => {
                onChange(color)
                setOpen(false)
              }}
              aria-label={`Select color ${color}`}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Normalize a raw string into a kebab-case handle. */
function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Generate a unique clone handle that doesn't collide with existing specialist IDs. */
function generateUniqueCloneHandle(baseHandle: string, existingIds: Set<string>): string {
  const candidate = `${baseHandle}-copy`
  if (!existingIds.has(candidate)) return candidate
  for (let i = 2; ; i++) {
    const numbered = `${baseHandle}-copy-${i}`
    if (!existingIds.has(numbered)) return numbered
  }
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

export function SettingsSpecialists({
  wsUrl,
  profiles,
  specialistChangeKey,
  modelConfigChangeKey,
}: SettingsSpecialistsProps) {
  useHelpContext('settings.specialists')

  const [selectedScope, setSelectedScope] = useState<string>(SCOPE_GLOBAL)
  const isGlobal = selectedScope === SCOPE_GLOBAL

  const modelPresets = useModelPresets(wsUrl, modelConfigChangeKey)
  const selectableModels = useMemo(() => getAllSelectableModels(modelPresets), [modelPresets])

  const [specialists, setSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRequestIdRef = useRef(0)
  const rosterRequestIdRef = useRef(0)

  // Global specialists enabled toggle
  const [specialistsEnabled, setSpecialistsEnabled] = useState(true)
  const [enabledLoading, setEnabledLoading] = useState(true)
  const [enabledToggling, setEnabledToggling] = useState(false)

  // Per-card edit states, keyed by specialistId
  const [editStates, setEditStates] = useState<Record<string, CardEditState>>({})
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set())
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(new Set())
  const [expandedFallbackIds, setExpandedFallbackIds] = useState<Set<string>>(new Set())
  const [customizeInitiatedIds, setCustomizeInitiatedIds] = useState<Set<string>>(new Set())
  const [pendingSaveId, setPendingSaveId] = useState<string | null>(null)

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
    setPendingSaveId(null)
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

  // Load global enabled state
  useEffect(() => {
    let cancelled = false
    setEnabledLoading(true)
    fetchSpecialistsEnabled(wsUrl)
      .then((enabled) => { if (!cancelled) setSpecialistsEnabled(enabled) })
      .catch(() => { /* default to true on error */ })
      .finally(() => { if (!cancelled) setEnabledLoading(false) })
    return () => { cancelled = true }
  }, [wsUrl, specialistChangeKey])

  const handleToggleEnabled = useCallback(async () => {
    const next = !specialistsEnabled
    setEnabledToggling(true)
    try {
      await setSpecialistsEnabledApi(wsUrl, next)
      setSpecialistsEnabled(next)
    } catch {
      // Revert on failure — the WS event will correct if needed
    } finally {
      setEnabledToggling(false)
    }
  }, [wsUrl, specialistsEnabled])

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
        if (!modelSupportsWebSearch(value, modelPresets)) {
          nextState.webSearch = false
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
    const newHandle = normalizeHandle(state.handle)
    const handleChanged = newHandle !== id

    // Validate handle
    if (!newHandle) {
      setCardErrors((prev) => ({ ...prev, [id]: 'Handle cannot be empty' }))
      return
    }
    if (handleChanged && specialists.some((s) => s.specialistId === newHandle)) {
      setCardErrors((prev) => ({ ...prev, [id]: `A specialist with handle "${newHandle}" already exists` }))
      return
    }

    await withCardAction(id, async () => {
      const payload = toSaveSpecialistPayload(state)
      const saveHandle = handleChanged ? newHandle : id

      // Save with the (possibly new) handle
      if (isGlobal) {
        await saveSharedSpecialist(wsUrl, saveHandle, payload)
      } else {
        await saveSpecialist(wsUrl, selectedScope, saveHandle, payload)
      }

      // If handle changed, delete the old file
      if (handleChanged) {
        try {
          if (isGlobal) {
            await deleteSharedSpecialistApi(wsUrl, id)
          } else {
            await deleteSpecialist(wsUrl, selectedScope, id)
          }
        } catch {
          // Best effort — new file already saved
        }
      }

      setCustomizeInitiatedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
      cancelEditing(id)
      await loadSpecialists()
    }, 'Save failed')
  }, [editStates, wsUrl, selectedScope, isGlobal, specialists, cancelEditing, loadSpecialists, withCardAction])

  const requestSave = useCallback((id: string, isBuiltin: boolean) => {
    const state = editStates[id]
    if (!state) return

    if (isBuiltin && !state.pinned) {
      setPendingSaveId(id)
      return
    }

    void handleSave(id)
  }, [editStates, handleSave])

  const confirmPendingSave = useCallback(() => {
    const id = pendingSaveId
    if (!id) return
    setPendingSaveId(null)
    void handleSave(id)
  }, [handleSave, pendingSaveId])

  const cancelPendingSave = useCallback(() => {
    setPendingSaveId(null)
  }, [])
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

  /** Toggle enabled on a global specialist — saves directly. */
  const handleGlobalToggleEnabled = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload({
        ...specialistToEditState(s),
        enabled: !s.enabled,
      })
      await saveSharedSpecialist(wsUrl, s.specialistId, payload)
      await loadSpecialists()
    }, 'Failed to toggle')
  }, [wsUrl, loadSpecialists, withCardAction])

  /** Toggle enabled on a profile-override specialist — saves directly. */
  const handleProfileToggleEnabled = useCallback(async (s: ResolvedSpecialistDefinition) => {
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

  const [cloningIds, setCloningIds] = useState<Set<string>>(new Set())

  const handleClone = useCallback(async (source: ResolvedSpecialistDefinition) => {
    const sourceId = source.specialistId
    setCloningIds((prev) => new Set(prev).add(sourceId))
    setCardErrors((prev) => { const next = { ...prev }; delete next[sourceId]; return next })
    try {
      const existingIds = new Set(specialists.map((s) => s.specialistId))
      const newHandle = generateUniqueCloneHandle(source.specialistId, existingIds)

      const payload: SaveSpecialistPayload = {
        displayName: `${source.displayName} (Copy)`,
        color: pickAvailableColor(specialists),
        enabled: true,
        whenToUse: source.whenToUse,
        modelId: source.modelId,
        reasoningLevel: (source.reasoningLevel as ManagerReasoningLevel) ?? undefined,
        fallbackModelId: source.fallbackModelId ?? undefined,
        fallbackReasoningLevel: (source.fallbackReasoningLevel as ManagerReasoningLevel) ?? undefined,
        pinned: false,
        webSearch: source.webSearch ?? false,
        promptBody: source.promptBody,
      }

      if (isGlobal) {
        await saveSharedSpecialist(wsUrl, newHandle, payload)
      } else {
        await saveSpecialist(wsUrl, selectedScope, newHandle, payload)
      }

      const updatedSpecialists = await loadSpecialists()
      const created = updatedSpecialists.find((s) => s.specialistId === newHandle)
      if (created) {
        startEditing(created)
        setExpandedPromptIds((prev) => new Set(prev).add(created.specialistId))
      }
    } catch (err) {
      setCardErrors((prev) => ({
        ...prev,
        [sourceId]: err instanceof Error ? err.message : 'Clone failed',
      }))
    } finally {
      setCloningIds((prev) => { const next = new Set(prev); next.delete(sourceId); return next })
    }
  }, [wsUrl, selectedScope, isGlobal, specialists, loadSpecialists, startEditing])

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
            <div className="space-y-2">
              {specialists.map((spec) => (
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
              <div className="space-y-2">
                {profileOverrides.map((spec) => (
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
              <div className="space-y-2">
                {inheritedSpecialists.map((spec) => (
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
            </SettingsSection>
          )}
        </div>
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

      <Dialog
        open={pendingSaveId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingSaveId(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save without pinning?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Your changes will be saved, but they <strong>will be overwritten</strong> the next time Forge updates its builtin specialists. To keep your customizations permanently, enable <strong>Pin customizations</strong> before saving.
          </DialogDescription>
          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" onClick={cancelPendingSave} disabled={pendingSaveId ? savingIds.has(pendingSaveId) : false}>
              Go back
            </Button>
            <Button
              variant="destructive"
              onClick={confirmPendingSave}
              disabled={pendingSaveId ? savingIds.has(pendingSaveId) : false}
            >
              {pendingSaveId && savingIds.has(pendingSaveId) && <Loader2 className="size-3 animate-spin" />}
              Save anyway
            </Button>
          </DialogFooter>
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
/*  Handle (filename) Field                                            */
/* ------------------------------------------------------------------ */

function HandleField({
  value,
  originalHandle,
  isBuiltin,
  isSaving,
  allSpecialists,
  onChange,
}: {
  value: string
  originalHandle: string
  isBuiltin: boolean
  isSaving: boolean
  allSpecialists: ResolvedSpecialistDefinition[]
  onChange: (value: string) => void
}) {
  const normalized = normalizeHandle(value)
  const isEmpty = normalized.length === 0
  const isConflict =
    normalized !== originalHandle &&
    allSpecialists.some((s) => s.specialistId === normalized)

  if (isBuiltin) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-medium text-muted-foreground">Handle</Label>
        <p className="text-sm font-mono text-muted-foreground/70">{originalHandle}.md</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-muted-foreground">Handle</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="my-specialist"
        className="h-9 text-sm font-mono"
        disabled={isSaving}
      />
      {normalized && normalized !== value.trim() && !isEmpty && !isConflict && (
        <p className="text-[11px] text-muted-foreground">
          → <span className="font-mono">{normalized}.md</span>
        </p>
      )}
      {normalized && normalized === value.trim() && !isEmpty && !isConflict && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-mono">{normalized}.md</span>
        </p>
      )}
      {isEmpty && value.length > 0 && (
        <p className="text-[11px] text-destructive">Handle cannot be empty.</p>
      )}
      {isConflict && (
        <p className="text-[11px] text-destructive">
          A specialist with handle &quot;{normalized}&quot; already exists.
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Unified Specialist Card — collapsed (compact) / expanded (edit)    */
/* ------------------------------------------------------------------ */

type SpecialistCardMode = 'global' | 'profileOverride' | 'inherited'

function SpecialistCard({
  mode,
  specialist,
  isEditing,
  editState,
  isSaving,
  isCloning,
  cardError,
  isPromptExpanded,
  isFallbackExpanded,
  onExpand,
  onCancelEditing,
  onUpdateField,
  onSave,
  onDelete,
  onRevert,
  onClone,
  onToggleEnabled,
  onTogglePrompt,
  onToggleFallback,
  modelPresets,
  selectableModels,
  allSpecialists,
}: {
  mode: SpecialistCardMode
  specialist: ResolvedSpecialistDefinition
  isEditing: boolean
  editState: CardEditState | undefined
  isSaving: boolean
  isCloning?: boolean
  cardError?: string
  isPromptExpanded: boolean
  isFallbackExpanded: boolean
  onExpand: () => void
  onCancelEditing: () => void
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  onSave: () => void
  onDelete?: () => void
  onRevert?: () => void
  onClone?: () => void
  onToggleEnabled: () => void
  onTogglePrompt: () => void
  onToggleFallback: () => void
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
  allSpecialists: ResolvedSpecialistDefinition[]
}) {
  const currentValues = isEditing && editState ? editState : specialistToEditState(specialist)

  // Compact summary values (used in collapsed state)
  const modelDisplay = getModelDisplayLabel(specialist.modelId, modelPresets)
  const reasoningLabel = REASONING_LEVEL_LABELS[specialist.reasoningLevel ?? 'high'] ?? specialist.reasoningLevel ?? 'High'
  const hasFallback = !!specialist.fallbackModelId
  const fallbackLabel = hasFallback ? getModelDisplayLabel(specialist.fallbackModelId!, modelPresets) : null
  const fallbackReasoningLabel = specialist.fallbackReasoningLevel
    ? REASONING_LEVEL_LABELS[specialist.fallbackReasoningLevel] ?? specialist.fallbackReasoningLevel
    : null

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation()

  /* ---- Collapsed state ---- */
  if (!isEditing) {
    return (
      <div
        className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 transition-colors hover:bg-muted/50 cursor-pointer"
        onClick={onExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand() } }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Left: badge, handle, model summary */}
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SpecialistBadge displayName={specialist.displayName} color={specialist.color} />
              <span className="font-mono text-xs text-muted-foreground/70">{specialist.specialistId}.md</span>
              {specialist.builtin && (
                <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Builtin
                </span>
              )}
              {specialist.builtin && specialist.pinned && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  <Pin className="size-2.5" />
                  Pinned
                </span>
              )}
              {!specialist.available && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3" />
                  {specialist.availabilityMessage || 'Unavailable'}
                </span>
              )}
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

          {/* Right: toggle + optional action button */}
          <div className="flex items-center gap-3 self-start shrink-0" onClick={stopPropagation}>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground/70" htmlFor={`enabled-${specialist.specialistId}`}>
                Enabled
              </Label>
              <Switch
                id={`enabled-${specialist.specialistId}`}
                size="sm"
                checked={specialist.enabled}
                disabled={isSaving}
                onCheckedChange={onToggleEnabled}
                aria-label={`Toggle ${specialist.specialistId} specialist`}
              />
            </div>
            {onClone && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClone}
                disabled={isSaving || isCloning}
                className="gap-1 text-xs text-muted-foreground hover:text-foreground h-7 px-2"
                aria-label={`Clone ${specialist.specialistId} specialist`}
              >
                {isCloning ? <Loader2 className="size-3 animate-spin" /> : <Copy className="size-3" />}
                Clone
              </Button>
            )}
            {mode === 'inherited' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onExpand}
                disabled={isSaving}
                className="gap-1 text-xs text-muted-foreground hover:text-foreground h-7 px-2"
              >
                {isSaving ? <Loader2 className="size-3 animate-spin" /> : <Pencil className="size-3" />}
                Customize
              </Button>
            )}
          </div>
        </div>

        {/* When to use — compact with truncation */}
        {specialist.whenToUse && (
          <p className="mt-1.5 text-xs text-muted-foreground/70 line-clamp-2">
            {specialist.whenToUse}
          </p>
        )}

        {cardError && (
          <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
            <p className="text-xs text-destructive">{cardError}</p>
          </div>
        )}
      </div>
    )
  }

  /* ---- Expanded state (editing) ---- */
  const promptLineCount = currentValues.promptBody.split('\n').length
  const supportedLevels = getSupportedReasoningLevelsForModelId(currentValues.modelId, modelPresets)
  const supportsWebSearch = modelSupportsWebSearch(currentValues.modelId, modelPresets)

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <SpecialistBadge displayName={currentValues.displayName} color={currentValues.color} />
          <span className="font-mono text-xs text-muted-foreground">{normalizeHandle(currentValues.handle) || specialist.specialistId}.md</span>
          {specialist.builtin && (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Builtin
            </span>
          )}
          {specialist.builtin && currentValues.pinned && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Pin className="size-2.5" />
              Pinned
            </span>
          )}
          {!specialist.available && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3" />
              {specialist.availabilityMessage || 'Unavailable'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 self-start">
          <Label className="text-xs font-medium text-muted-foreground" htmlFor={`enabled-edit-${specialist.specialistId}`}>
            Enabled
          </Label>
          <Switch
            id={`enabled-edit-${specialist.specialistId}`}
            size="sm"
            checked={currentValues.enabled}
            disabled={isSaving}
            onCheckedChange={(checked) => onUpdateField('enabled', checked)}
            aria-label={`Toggle ${specialist.specialistId} specialist`}
          />
        </div>
      </div>

      {/* Handle (filename) */}
      <HandleField
        value={currentValues.handle}
        originalHandle={specialist.specialistId}
        isBuiltin={specialist.builtin}
        isSaving={isSaving}
        allSpecialists={allSpecialists}
        onChange={(v) => onUpdateField('handle', v)}
      />

      {/* Display name + badge color */}
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
            <ColorSwatchPicker
              value={currentValues.color}
              onChange={(color) => onUpdateField('color', color)}
            />
          </div>
        </div>
      </div>

      {/* When to use */}
      <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">When to use</Label>
        <Textarea
          value={currentValues.whenToUse}
          onChange={(e) => onUpdateField('whenToUse', e.target.value)}
          rows={2}
          className="resize-none text-xs"
        />
      </div>

      {/* Model + reasoning */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex flex-col gap-1.5 sm:w-52">
          <Label className="text-xs font-medium text-muted-foreground">Model</Label>
          <ModelIdSelect
            value={currentValues.modelId}
            onValueChange={(v) => onUpdateField('modelId', v)}
            models={selectableModels}
            presets={modelPresets}
            placeholder="Select model"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-40">
          <Label className="text-xs font-medium text-muted-foreground">Reasoning level</Label>
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
        </div>
      </div>

      {/* Fallback */}
      <FallbackModelSection
        isEditing={true}
        isExpanded={isFallbackExpanded}
        onToggle={onToggleFallback}
        fallbackModelId={currentValues.fallbackModelId}
        fallbackReasoningLevel={currentValues.fallbackReasoningLevel}
        onUpdateField={onUpdateField}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
      />

      {supportsWebSearch && (
        <div className="flex items-center gap-2">
          <Switch
            checked={currentValues.webSearch}
            onCheckedChange={(checked) => onUpdateField('webSearch', checked)}
          />
          <Label>Native Search</Label>
          <span className="text-xs text-muted-foreground">
            Enable xAI native search (web + X) for this specialist
          </span>
        </div>
      )}

      {/* System prompt */}
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
          <Textarea
            value={currentValues.promptBody}
            onChange={(e) => onUpdateField('promptBody', e.target.value)}
            rows={12}
            className="resize-y font-mono text-xs"
          />
        )}
      </div>

      {specialist.builtin && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Pin customizations</p>
              <p className="text-[11px] text-muted-foreground">
                Pinned specialists won&apos;t be updated by Forge. Unpin to restore automatic updates.
              </p>
            </div>
            <Switch
              size="sm"
              checked={currentValues.pinned}
              disabled={isSaving}
              onCheckedChange={(checked) => onUpdateField('pinned', checked)}
              aria-label={`Toggle pinned state for ${specialist.specialistId}`}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {cardError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{cardError}</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-1">
          {isSaving && <Loader2 className="size-3 animate-spin" />}
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onCancelEditing} disabled={isSaving}>
          Cancel
        </Button>
        <div className="flex-1" />
        {mode === 'global' && !specialist.builtin && onDelete && (
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
        {mode === 'profileOverride' && specialist.shadowsGlobal && onRevert && (
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
        )}
        {mode === 'profileOverride' && !specialist.shadowsGlobal && onDelete && (
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
      </div>
    </div>
  )
}
