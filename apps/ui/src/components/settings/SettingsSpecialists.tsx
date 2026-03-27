import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Eye, Loader2, RotateCcw, Trash2 } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
  fetchRosterPrompt,
  saveSpecialist,
  deleteSpecialist,
  type SaveSpecialistPayload,
} from './specialists-api'
import type {
  ManagerModelPreset,
  ManagerProfile,
  ManagerReasoningLevel,
  ResolvedSpecialistDefinition,
} from '@forge/protocol'
import { MANAGER_MODEL_PRESETS, MANAGER_REASONING_LEVELS } from '@forge/protocol'

const REASONING_LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

interface SettingsSpecialistsProps {
  wsUrl: string
  profiles: ManagerProfile[]
  specialistChangeKey: number
}

function isManagerModelPreset(value: string): value is ManagerModelPreset {
  return MANAGER_MODEL_PRESETS.includes(value as ManagerModelPreset)
}

function isManagerReasoningLevel(value: string): value is ManagerReasoningLevel {
  return MANAGER_REASONING_LEVELS.includes(value as ManagerReasoningLevel)
}

interface CardEditState {
  displayName: string
  color: string
  enabled: boolean
  whenToUse: string
  model: string
  reasoningLevel: string
  promptBody: string
}

function specialistToEditState(s: ResolvedSpecialistDefinition): CardEditState {
  return {
    displayName: s.displayName,
    color: s.color,
    enabled: s.enabled,
    whenToUse: s.whenToUse,
    model: s.model,
    reasoningLevel: s.reasoningLevel ?? 'high',
    promptBody: s.promptBody,
  }
}

function toSaveSpecialistPayload(state: CardEditState): SaveSpecialistPayload {
  if (!isManagerModelPreset(state.model)) {
    throw new Error(`Model preset is invalid: ${state.model}`)
  }

  const reasoningLevel = state.reasoningLevel.trim()
  if (reasoningLevel && !isManagerReasoningLevel(reasoningLevel)) {
    throw new Error(`Reasoning level is invalid: ${reasoningLevel}`)
  }

  const normalizedReasoningLevel = reasoningLevel
    ? (reasoningLevel as ManagerReasoningLevel)
    : undefined

  return {
    displayName: state.displayName,
    color: state.color,
    enabled: state.enabled,
    whenToUse: state.whenToUse,
    model: state.model,
    reasoningLevel: normalizedReasoningLevel,
    promptBody: state.promptBody,
  }
}

export function SettingsSpecialists({ wsUrl, profiles, specialistChangeKey }: SettingsSpecialistsProps) {
  const defaultProfileId = profiles.length > 0 ? profiles[0].profileId : ''
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId)
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

  // Roster prompt dialog
  const [rosterOpen, setRosterOpen] = useState(false)
  const [rosterMarkdown, setRosterMarkdown] = useState('')
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedProfileId((prev) => {
      if (prev && profiles.some((p) => p.profileId === prev)) return prev
      return profiles.length > 0 ? profiles[0].profileId : ''
    })
  }, [profiles])

  useEffect(() => {
    rosterRequestIdRef.current += 1
    setSpecialists([])
    setLoading(Boolean(selectedProfileId))
    setError(null)
    setRosterLoading(false)
    setRosterMarkdown('')
    setRosterError(null)
  }, [selectedProfileId])

  const loadSpecialists = useCallback(async (): Promise<ResolvedSpecialistDefinition[]> => {
    if (!selectedProfileId) {
      setSpecialists([])
      setLoading(false)
      setError(null)
      return []
    }

    const requestId = ++loadRequestIdRef.current
    setLoading(true)
    setError(null)

    try {
      const data = await fetchSpecialists(wsUrl, selectedProfileId)
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
  }, [wsUrl, selectedProfileId])

  useEffect(() => {
    void loadSpecialists()
  }, [loadSpecialists, specialistChangeKey])

  useEffect(() => {
    setEditingIds(new Set())
    setEditStates({})
    setCardErrors({})
    setExpandedPromptIds(new Set())
  }, [selectedProfileId])

  const startEditing = useCallback((s: ResolvedSpecialistDefinition) => {
    setEditStates((prev) => ({ ...prev, [s.specialistId]: specialistToEditState(s) }))
    setEditingIds((prev) => new Set(prev).add(s.specialistId))
    setCardErrors(({ [s.specialistId]: _, ...rest }) => rest)
  }, [])

  const cancelEditing = useCallback((id: string) => {
    setEditingIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    setEditStates(({ [id]: _, ...rest }) => rest)
    setCardErrors(({ [id]: _, ...rest }) => rest)
  }, [])

  const updateEditField = useCallback((id: string, field: keyof CardEditState, value: string | boolean) => {
    setEditStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }))
  }, [])

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
      await saveSpecialist(wsUrl, selectedProfileId, id, payload)
      cancelEditing(id)
      await loadSpecialists()
    }, 'Save failed')
  }, [editStates, wsUrl, selectedProfileId, cancelEditing, loadSpecialists, withCardAction])

  const handleCreateOverride = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload(specialistToEditState(s))
      await saveSpecialist(wsUrl, selectedProfileId, s.specialistId, payload)
      const updatedSpecialists = await loadSpecialists()
      const updated = updatedSpecialists.find((sp) => sp.specialistId === s.specialistId)
      if (updated) startEditing(updated)
    }, 'Failed to create override')
  }, [wsUrl, selectedProfileId, loadSpecialists, startEditing, withCardAction])

  const handleRevert = useCallback(async (id: string) => {
    await withCardAction(id, async () => {
      await deleteSpecialist(wsUrl, selectedProfileId, id)
      cancelEditing(id)
      await loadSpecialists()
    }, 'Revert failed')
  }, [wsUrl, selectedProfileId, cancelEditing, loadSpecialists, withCardAction])

  const handleDelete = useCallback(async (id: string) => {
    await withCardAction(id, async () => {
      await deleteSpecialist(wsUrl, selectedProfileId, id)
      cancelEditing(id)
      await loadSpecialists()
    }, 'Delete failed')
  }, [wsUrl, selectedProfileId, cancelEditing, loadSpecialists, withCardAction])

  const togglePromptExpand = useCallback((id: string) => {
    setExpandedPromptIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleViewRoster = useCallback(async () => {
    if (!selectedProfileId) return

    const requestId = ++rosterRequestIdRef.current
    setRosterOpen(true)
    setRosterLoading(true)
    setRosterError(null)

    try {
      const markdown = await fetchRosterPrompt(wsUrl, selectedProfileId)
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
  }, [wsUrl, selectedProfileId])

  const sortedSpecialists = useMemo(
    () => [...specialists].sort((a, b) => a.specialistId.localeCompare(b.specialistId)),
    [specialists],
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Profile selector */}
      {profiles.length > 1 && (
        <SettingsSection
          label="Profile"
          description="Select which profile's specialist roster to manage."
        >
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Configuration scope</Label>
            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Select profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.profileId} value={profile.profileId}>
                    {profile.displayName || profile.profileId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        label="Named Specialists"
        description="Configure named worker specialist templates. Specialists define model, reasoning, and prompt for common worker roles."
        cta={
          <Button
            variant="outline"
            size="sm"
            onClick={handleViewRoster}
            disabled={!selectedProfileId || rosterLoading}
            className="gap-1.5"
          >
            <Eye className="size-3.5" />
            Roster Prompt
          </Button>
        }
      >
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

        {!loading && sortedSpecialists.length === 0 && !error && (
          <p className="py-4 text-sm text-muted-foreground">No specialists found for this profile.</p>
        )}

        {!loading && sortedSpecialists.map((spec) => (
          <SpecialistCard
            key={spec.specialistId}
            specialist={spec}
            isEditing={editingIds.has(spec.specialistId)}
            editState={editStates[spec.specialistId]}
            isSaving={savingIds.has(spec.specialistId)}
            cardError={cardErrors[spec.specialistId]}
            isPromptExpanded={expandedPromptIds.has(spec.specialistId)}
            onStartEditing={() => startEditing(spec)}
            onCancelEditing={() => cancelEditing(spec.specialistId)}
            onUpdateField={(field, value) => updateEditField(spec.specialistId, field, value)}
            onSave={() => handleSave(spec.specialistId)}
            onCreateOverride={() => handleCreateOverride(spec)}
            onRevert={() => handleRevert(spec.specialistId)}
            onDelete={() => handleDelete(spec.specialistId)}
            onTogglePrompt={() => togglePromptExpand(spec.specialistId)}
          />
        ))}
      </SettingsSection>

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
/*  Individual specialist card                                         */
/* ------------------------------------------------------------------ */

function SpecialistCard({
  specialist,
  isEditing,
  editState,
  isSaving,
  cardError,
  isPromptExpanded,
  onStartEditing,
  onCancelEditing,
  onUpdateField,
  onSave,
  onCreateOverride,
  onRevert,
  onDelete,
  onTogglePrompt,
}: {
  specialist: ResolvedSpecialistDefinition
  isEditing: boolean
  editState: CardEditState | undefined
  isSaving: boolean
  cardError?: string
  isPromptExpanded: boolean
  onStartEditing: () => void
  onCancelEditing: () => void
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  onSave: () => void
  onCreateOverride: () => void
  onRevert: () => void
  onDelete: () => void
  onTogglePrompt: () => void
}) {
  const isProfileSource = specialist.sourceKind === 'profile'
  const currentValues = isEditing && editState ? editState : specialistToEditState(specialist)
  const sourceLabel = { builtin: 'Builtin', global: 'Global', profile: 'Profile' }[specialist.sourceKind]
  const promptLineCount = currentValues.promptBody.split('\n').length
  const hasValidModelSelection = isManagerModelPreset(currentValues.model)

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <SpecialistBadge displayName={currentValues.displayName} color={currentValues.color} />
            <span className="font-mono text-xs text-muted-foreground">{specialist.specialistId}.md</span>
            <Badge variant={isProfileSource ? 'default' : 'secondary'} className="px-1.5 py-0 text-[10px]">
              {sourceLabel}
            </Badge>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex flex-col gap-1.5 sm:w-52">
          <Label className="text-xs font-medium text-muted-foreground">Model preset</Label>
          {isEditing ? (
            <>
              <Select
                value={hasValidModelSelection ? currentValues.model : undefined}
                onValueChange={(value) => onUpdateField('model', value)}
              >
                <SelectTrigger className="w-full text-xs">
                  <SelectValue placeholder={hasValidModelSelection ? 'Select model preset' : currentValues.model || 'Select model preset'} />
                </SelectTrigger>
                <SelectContent>
                  {MANAGER_MODEL_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset} className="text-xs">
                      {preset}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!hasValidModelSelection ? (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Pick a valid model preset to repair this specialist.
                </p>
              ) : null}
            </>
          ) : (
            <span className="font-mono text-xs text-foreground/80">{specialist.model}</span>
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
                {MANAGER_REASONING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {REASONING_LEVEL_LABELS[level] || level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-xs text-foreground/80">
              {REASONING_LEVEL_LABELS[specialist.reasoningLevel ?? 'high'] ?? specialist.reasoningLevel ?? 'high'}
            </span>
          )}
        </div>
      </div>

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
        ) : isProfileSource ? (
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
        ) : (
          <Button size="sm" variant="outline" onClick={onCreateOverride} disabled={isSaving} className="gap-1">
            {isSaving ? <Loader2 className="size-3 animate-spin" /> : null}
            Create profile override
          </Button>
        )}
      </div>
    </div>
  )
}
