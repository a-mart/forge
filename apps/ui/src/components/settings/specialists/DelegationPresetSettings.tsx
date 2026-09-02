import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type DelegationBehaviorMode,
  type DelegationRoster,
  type DelegationRosterSettings,
  type DelegationRoute,
  type ModelPresetInfo,
  type ResolvedSpecialistDefinition,
} from '@forge/protocol'
import {
  Check,
  Compass,
  Copy,
  Hammer,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Plus,
  Save,
  ShieldCheck,
  Telescope,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  getModelDisplayLabel,
  getSupportedReasoningLevelsForModelId,
  type SelectableModel,
} from '@/lib/model-preset'
import { formatReasoningLevel } from '@/lib/reasoning-level-labels'
import { cn } from '@/lib/utils'
import type { SettingsApiClient } from '../settings-api-client'
import {
  fetchDelegationRosterSettings,
  saveDelegationRosterSettingsApi,
} from '../specialists-api'
import { DelegationPolicyEditor } from './DelegationPolicyEditor'
import {
  addPolicy,
  cloneDelegationSettings,
  clonePreset,
  duplicatePolicy,
  nextId,
  removePolicy,
  selectedPolicyIdForTask,
  behaviorModeForSpecialist,
  isDefaultSpecialistForTask,
  taskAssignmentLabel,
  tasksUsingPolicy,
  setDefaultSpecialistForTask,
  setSpecialistBehaviorMode,
} from './delegation-preset-utils'

const TASK_TYPE_ICONS: Record<DelegationBehaviorMode, LucideIcon> = {
  general: Hammer,
  plan: ListChecks,
  'correctness-review': ShieldCheck,
  'design-review': Compass,
  research: Telescope,
}

export function DelegationPresetSettingsView({
  clientOrWsUrl,
  modelPresets,
  selectableModels,
  taskInstructions,
  refreshKey,
}: {
  clientOrWsUrl: SettingsApiClient | string
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
  taskInstructions: ResolvedSpecialistDefinition[]
  refreshKey?: number
}) {
  const [settings, setSettings] = useState<DelegationRosterSettings | null>(null)
  const [savedSettings, setSavedSettings] = useState<DelegationRosterSettings | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedPolicyId, setSelectedPolicyId] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [presetDetailsOpen, setPresetDetailsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetchDelegationRosterSettings(clientOrWsUrl)
      const cloned = cloneDelegationSettings(next)
      setSettings(cloned)
      setSavedSettings(cloneDelegationSettings(next))
      setSelectedPresetId((currentPresetId) => {
        const presetId = next.rosters.some((preset) => preset.rosterId === currentPresetId)
          ? currentPresetId
          : next.defaultRosterId
        const preset = next.rosters.find((candidate) => candidate.rosterId === presetId)
          ?? next.rosters[0]!
        setSelectedPolicyId(selectedPolicyIdForTask(preset, 'general'))
        return preset.rosterId
      })
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [clientOrWsUrl])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const selectedPreset = useMemo(
    () => settings?.rosters.find((preset) => preset.rosterId === selectedPresetId),
    [settings, selectedPresetId],
  )
  const selectedPolicy = useMemo(
    () => selectedPreset?.routes.find((policy) => policy.routeId === selectedPolicyId)
      ?? selectedPreset?.routes[0],
    [selectedPolicyId, selectedPreset],
  )
  const dirty = useMemo(
    () => !!settings && !!savedSettings
      && JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [savedSettings, settings],
  )

  useEffect(() => {
    if (!selectedPreset || !selectedPolicy) return
    if (selectedPolicy.routeId !== selectedPolicyId) {
      setSelectedPolicyId(selectedPolicy.routeId)
    }
  }, [selectedPolicy, selectedPolicyId, selectedPreset])

  const updateSelectedPreset = useCallback(
    (update: (preset: DelegationRoster) => DelegationRoster) => {
      setJustSaved(false)
      setSettings((current) => current
        ? {
            ...current,
            rosters: current.rosters.map((preset) => (
              preset.rosterId === selectedPresetId ? update(preset) : preset
            )),
          }
        : current)
    },
    [selectedPresetId],
  )

  const updateSelectedPolicy = useCallback((nextPolicy: DelegationRoute) => {
    updateSelectedPreset((preset) => ({
      ...preset,
      routes: preset.routes.map((policy) => (
        policy.routeId === nextPolicy.routeId ? nextPolicy : policy
      )),
    }))
  }, [updateSelectedPreset])

  const selectPreset = useCallback((presetId: string) => {
    const preset = settings?.rosters.find((candidate) => candidate.rosterId === presetId)
    if (!preset) return
    setSelectedPresetId(presetId)
    setSelectedPolicyId(selectedPolicyIdForTask(preset, 'general'))
    setAdvancedOpen(false)
    setPresetDetailsOpen(false)
  }, [settings])

  const save = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveDelegationRosterSettingsApi(clientOrWsUrl, settings)
      const cloned = cloneDelegationSettings(saved)
      setSettings(cloned)
      setSavedSettings(cloneDelegationSettings(saved))
      setJustSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setJustSaved(false), 2400)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }, [clientOrWsUrl, settings])

  const discard = useCallback(() => {
    if (!savedSettings) return
    const restored = cloneDelegationSettings(savedSettings)
    setSettings(restored)
    const preset = restored.rosters.find((candidate) => candidate.rosterId === selectedPresetId)
      ?? restored.rosters[0]!
    setSelectedPresetId(preset.rosterId)
    setSelectedPolicyId(selectedPolicyIdForTask(preset, 'general'))
    setError(null)
    setJustSaved(false)
  }, [savedSettings, selectedPresetId])

  if (loading) {
    return (
      <div className="flex items-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading rosters
      </div>
    )
  }

  if (!settings || !selectedPreset || !selectedPolicy) {
    return (
      <p className="py-4 text-sm text-destructive">
        {error ?? 'No roster is available.'}
      </p>
    )
  }

  const createPreset = () => {
    const presetId = nextId(
      'roster',
      new Set(settings.rosters.map((preset) => preset.rosterId)),
    )
    const preset: DelegationRoster = {
      ...clonePreset(selectedPreset),
      rosterId: presetId,
      revision: 1,
      name: `New roster ${settings.rosters.length + 1}`,
    }
    setSettings({ ...settings, rosters: [...settings.rosters, preset] })
    setSelectedPresetId(presetId)
    setSelectedPolicyId(selectedPolicyIdForTask(preset, 'general'))
    setPresetDetailsOpen(true)
    setJustSaved(false)
  }

  const duplicateSelectedPreset = () => {
    const presetId = nextId(
      `${selectedPreset.rosterId}-copy`,
      new Set(settings.rosters.map((preset) => preset.rosterId)),
    )
    const preset = {
      ...clonePreset(selectedPreset),
      rosterId: presetId,
      revision: 1,
      name: `${selectedPreset.name} copy`,
    }
    setSettings({ ...settings, rosters: [...settings.rosters, preset] })
    setSelectedPresetId(presetId)
    setSelectedPolicyId(selectedPolicyIdForTask(preset, 'general'))
    setPresetDetailsOpen(true)
    setJustSaved(false)
  }

  const deleteSelectedPreset = () => {
    if (settings.rosters.length <= 1) return
    const rosters = settings.rosters.filter(
      (preset) => preset.rosterId !== selectedPreset.rosterId,
    )
    const defaultRosterId = settings.defaultRosterId === selectedPreset.rosterId
      ? rosters[0]!.rosterId
      : settings.defaultRosterId
    const nextSettings = { ...settings, defaultRosterId, rosters }
    const nextPreset = rosters.find((preset) => preset.rosterId === defaultRosterId)
      ?? rosters[0]!
    setSettings(nextSettings)
    setSelectedPresetId(nextPreset.rosterId)
    setSelectedPolicyId(selectedPolicyIdForTask(nextPreset, 'general'))
    setPresetDetailsOpen(false)
    setJustSaved(false)
  }

  const addNewPolicy = () => {
    const result = addPolicy(selectedPreset)
    updateSelectedPreset(() => result.preset)
    setSelectedPolicyId(result.policyId)
    setAdvancedOpen(false)
  }

  const duplicateSelectedPolicy = () => {
    const result = duplicatePolicy(selectedPreset, selectedPolicy.routeId)
    updateSelectedPreset(() => result.preset)
    setSelectedPolicyId(result.policyId)
    setAdvancedOpen(false)
  }

  const deleteSelectedPolicy = () => {
    if (isDefaultSpecialistForTask(selectedPreset, selectedPolicy.routeId)) return
    const nextPreset = removePolicy(selectedPreset, selectedPolicy.routeId)
    updateSelectedPreset(() => nextPreset)
    setSelectedPolicyId(nextPreset.defaultRouteId)
    setAdvancedOpen(false)
  }

  const selectedBehaviorMode = behaviorModeForSpecialist(
    selectedPreset,
    selectedPolicy.routeId,
  )
  const selectedInstruction = taskInstructions.find(
    (instruction) => getBehaviorModeForInstruction(instruction.specialistId) === selectedBehaviorMode,
  )

  return (
    <div className="relative -mx-1">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-1 pb-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Roster
          </span>
          {settings.rosters.length === 1 ? (
            <div className="flex h-9 items-center rounded-md border border-border/70 bg-muted/25 px-3 text-sm font-medium">
              {selectedPreset.name}
              {selectedPreset.rosterId === settings.defaultRosterId && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  Default
                </span>
              )}
            </div>
          ) : (
            <Select value={selectedPresetId} onValueChange={selectPreset}>
              <SelectTrigger className="min-w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settings.rosters.map((preset) => (
                  <SelectItem key={preset.rosterId} value={preset.rosterId}>
                    {preset.name}
                    {preset.rosterId === settings.defaultRosterId ? ' — Default' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <span className="text-xs text-muted-foreground">
            {selectedPreset.routes.length} specialists
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={createPreset}>
            <Plus className="size-3.5" />
            New roster
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={duplicateSelectedPreset}>
            <Copy className="size-3.5" />
            Duplicate roster
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" aria-label="Roster actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setPresetDetailsOpen((open) => !open)}>
                Edit roster details
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={selectedPreset.rosterId === settings.defaultRosterId}
                onClick={() => {
                  setSettings({ ...settings, defaultRosterId: selectedPreset.rosterId })
                  setJustSaved(false)
                }}
              >
                Set as global default
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={settings.rosters.length <= 1}
                onClick={deleteSelectedPreset}
              >
                <Trash2 className="size-4" />
                Delete roster
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {presetDetailsOpen && (
        <div className="mt-3 grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 md:grid-cols-[minmax(12rem,20rem)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label htmlFor={`preset-name-${selectedPreset.rosterId}`}>Roster name</Label>
            <Input
              id={`preset-name-${selectedPreset.rosterId}`}
              value={selectedPreset.name}
              onChange={(event) => updateSelectedPreset((preset) => ({
                ...preset,
                name: event.target.value,
              }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`preset-description-${selectedPreset.rosterId}`}>Description</Label>
            <Textarea
              id={`preset-description-${selectedPreset.rosterId}`}
              value={selectedPreset.description ?? ''}
              rows={1}
              onChange={(event) => updateSelectedPreset((preset) => ({
                ...preset,
                description: event.target.value || undefined,
              }))}
            />
          </div>
        </div>
      )}

      <div className="mt-4 grid min-h-[38rem] gap-5 min-[1200px]:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="space-y-5 min-[1200px]:border-r min-[1200px]:border-border/60 min-[1200px]:pr-4">
          <section>
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide">
                  Roster specialists
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Each specialist combines task instructions with its model and recovery behavior.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{selectedPreset.routes.length}</span>
            </div>
            <div className="mt-3 space-y-1.5">
              {selectedPreset.routes.map((policy) => {
                const active = policy.routeId === selectedPolicy.routeId
                const behaviorMode = behaviorModeForSpecialist(selectedPreset, policy.routeId)
                const isDefault = tasksUsingPolicy(selectedPreset, policy.routeId).length > 0
                const taskLabel = taskAssignmentLabel(selectedPreset, policy.routeId)
                const Icon = TASK_TYPE_ICONS[behaviorMode]
                return (
                  <button
                    key={policy.routeId}
                    type="button"
                    className={cn(
                      'w-full rounded-md border border-l-2 p-2.5 text-left transition-colors',
                      active
                        ? 'border-border border-l-foreground/70 bg-muted/45'
                        : 'border-border/50 border-l-transparent bg-muted/15 hover:bg-muted/30',
                    )}
                    onClick={() => {
                      setSelectedPolicyId(policy.routeId)
                      setAdvancedOpen(false)
                    }}
                  >
                    <span className="flex items-start gap-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="truncate text-xs font-semibold">{policy.label}</span>
                          <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                            {formatReasoningLevel(
                              policy.reasoningLevel,
                              getSupportedReasoningLevelsForModelId(
                                policy.modelId,
                                modelPresets,
                                policy.provider,
                              ),
                            )} reasoning
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                          {taskLabel}
                          {isDefault ? ' · default' : ' · alternative'}
                        </span>
                      </span>
                    </span>
                    <span className="mt-2 block truncate text-[11px] text-muted-foreground">
                      {getModelDisplayLabel(policy.modelId, modelPresets, policy.provider)}
                    </span>
                  </button>
                )
              })}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-full border-dashed"
              onClick={addNewPolicy}
            >
              <Plus className="size-3.5" />
              Add specialist
            </Button>
          </section>
        </aside>

        <DelegationPolicyEditor
          policy={selectedPolicy}
          preset={selectedPreset}
          modelPresets={modelPresets}
          selectableModels={selectableModels}
          instruction={selectedInstruction}
          advancedOpen={advancedOpen}
          onAdvancedOpenChange={setAdvancedOpen}
          onChange={updateSelectedPolicy}
          onBehaviorModeChange={(behaviorMode) => {
            updateSelectedPreset((preset) => (
              setSpecialistBehaviorMode(preset, selectedPolicy.routeId, behaviorMode)
            ))
          }}
          onMakeDefault={() => {
            updateSelectedPreset((preset) => (
              setDefaultSpecialistForTask(preset, selectedPolicy.routeId)
            ))
          }}
          onDuplicate={duplicateSelectedPolicy}
          onDelete={deleteSelectedPolicy}
        />
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {(dirty || justSaved) && (
        <div className={cn(
          'sticky bottom-0 z-20 -mx-1 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur',
          dirty
            ? 'border-amber-400/25 bg-background/95'
            : 'border-border/70 bg-background/90',
        )}>
          <div className="flex items-center gap-2">
            <span className={cn(
              'flex size-5 items-center justify-center rounded-full',
              dirty ? 'bg-amber-400/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-400',
            )}>
              {dirty ? <span className="size-1.5 rounded-full bg-current" /> : <Check className="size-3" />}
            </span>
            <span>
              <span className="block text-sm font-medium">
                {dirty ? 'Unsaved changes' : 'Roster saved'}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {dirty
                  ? `Changes to ${selectedPreset.name} are not live yet`
                  : `${selectedPreset.name} is live for future attempts`}
              </span>
            </span>
          </div>
          {dirty && (
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={discard}>
                Discard
              </Button>
              <Button type="button" size="sm" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                Save roster
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getBehaviorModeForInstruction(
  specialistId: string,
): DelegationBehaviorMode | undefined {
  if (specialistId === 'planner') return 'plan'
  if (specialistId === 'code-reviewer') return 'correctness-review'
  if (specialistId === 'code-reviewer-2') return 'design-review'
  if (specialistId === 'researcher') return 'research'
  return undefined
}
