import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DELEGATION_BEHAVIOR_MODES,
  MANAGER_REASONING_LEVELS,
  type DelegationBehaviorMode,
  type DelegationRoster,
  type DelegationRosterSettings,
  type DelegationRoute,
  type ManagerReasoningLevel,
  type ModelPresetInfo,
} from '@forge/protocol'
import { Copy, Loader2, Plus, Save, Trash2 } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  getSupportedReasoningLevelsForModelId,
  type SelectableModel,
} from '@/lib/model-preset'
import type { SettingsApiClient } from '../settings-api-client'
import {
  fetchDelegationRosterSettings,
  saveDelegationRosterSettingsApi,
} from '../specialists-api'
import { ModelIdSelect } from './ModelIdSelect'
import { formatReasoningLevel } from '@/lib/reasoning-level-labels'

const MODE_LABELS: Record<DelegationBehaviorMode, string> = {
  general: 'Build & execute',
  plan: 'Planning',
  'correctness-review': 'Correctness review',
  'design-review': 'Design review',
  research: 'Research',
}

export function DelegationRosterSettingsView({
  clientOrWsUrl,
  modelPresets,
  selectableModels,
  refreshKey,
}: {
  clientOrWsUrl: SettingsApiClient | string
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
  refreshKey?: number
}) {
  const [settings, setSettings] = useState<DelegationRosterSettings | null>(null)
  const [selectedRosterId, setSelectedRosterId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetchDelegationRosterSettings(clientOrWsUrl)
      setSettings(next)
      setSelectedRosterId((current) => (
        next.rosters.some((roster) => roster.rosterId === current)
          ? current
          : next.defaultRosterId
      ))
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

  const selectedRoster = useMemo(
    () => settings?.rosters.find((roster) => roster.rosterId === selectedRosterId),
    [settings, selectedRosterId],
  )

  const updateSelectedRoster = useCallback((update: (roster: DelegationRoster) => DelegationRoster) => {
    setSettings((current) => current
      ? {
          ...current,
          rosters: current.rosters.map((roster) => (
            roster.rosterId === selectedRosterId ? update(roster) : roster
          )),
        }
      : current)
  }, [selectedRosterId])

  const save = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveDelegationRosterSettingsApi(clientOrWsUrl, settings)
      setSettings(saved)
      setSelectedRosterId((current) => (
        saved.rosters.some((roster) => roster.rosterId === current)
          ? current
          : saved.defaultRosterId
      ))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }, [clientOrWsUrl, settings])

  const duplicateRoster = useCallback(() => {
    if (!settings || !selectedRoster) return
    const rosterId = nextId(
      selectedRoster.rosterId,
      new Set(settings.rosters.map((roster) => roster.rosterId)),
    )
    const clone: DelegationRoster = {
      ...selectedRoster,
      rosterId,
      revision: 1,
      name: `${selectedRoster.name} Copy`,
      modeRoutes: selectedRoster.modeRoutes ? { ...selectedRoster.modeRoutes } : undefined,
      routes: selectedRoster.routes.map(cloneRoute),
    }
    setSettings({ ...settings, rosters: [...settings.rosters, clone] })
    setSelectedRosterId(rosterId)
  }, [selectedRoster, settings])

  const deleteRoster = useCallback(() => {
    if (!settings || settings.rosters.length <= 1) return
    const rosters = settings.rosters.filter((roster) => roster.rosterId !== selectedRosterId)
    const defaultRosterId = settings.defaultRosterId === selectedRosterId
      ? rosters[0]!.rosterId
      : settings.defaultRosterId
    setSettings({ ...settings, defaultRosterId, rosters })
    setSelectedRosterId(defaultRosterId)
  }, [selectedRosterId, settings])

  if (loading) {
    return (
      <div className="flex items-center py-3 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" />
        Loading worker rosters
      </div>
    )
  }

  if (!settings || !selectedRoster) {
    return (
      <p className="text-xs text-destructive">
        {error ?? 'No worker roster is available.'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label className="text-xs text-muted-foreground">Roster</Label>
          <Select value={selectedRosterId} onValueChange={setSelectedRosterId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {settings.rosters.map((roster) => (
                <SelectItem key={roster.rosterId} value={roster.rosterId}>
                  {roster.name}
                  {roster.rosterId === settings.defaultRosterId ? ' · Global default' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={duplicateRoster} className="gap-1.5">
            <Copy className="size-3.5" />
            Duplicate
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={deleteRoster}
            disabled={settings.rosters.length <= 1}
            aria-label="Delete roster"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save rosters
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Name</Label>
          <Input
            value={selectedRoster.name}
            onChange={(event) => updateSelectedRoster((roster) => ({
              ...roster,
              name: event.target.value,
            }))}
          />
          <p className="font-mono text-[11px] text-muted-foreground">{selectedRoster.rosterId}</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Global default</Label>
          <Select
            value={settings.defaultRosterId}
            onValueChange={(defaultRosterId) => setSettings({ ...settings, defaultRosterId })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {settings.rosters.map((roster) => (
                <SelectItem key={roster.rosterId} value={roster.rosterId}>
                  {roster.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs text-muted-foreground">Description</Label>
          <Textarea
            value={selectedRoster.description ?? ''}
            rows={2}
            onChange={(event) => updateSelectedRoster((roster) => ({
              ...roster,
              description: event.target.value || undefined,
            }))}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border/60 p-3">
        <p className="text-sm font-medium">Automatic worker selection</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose the execution profile Forge normally uses for each type of delegated task.
        </p>
        <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
          {DELEGATION_BEHAVIOR_MODES.map((mode) => (
            <RouteSelect
              key={mode}
              label={MODE_LABELS[mode]}
              value={selectedRoster.modeRoutes?.[mode] ?? selectedRoster.defaultRouteId}
              roster={selectedRoster}
              onChange={(routeId) => updateSelectedRoster((roster) => ({
                ...roster,
                ...(mode === 'general' ? { defaultRouteId: routeId } : {}),
                modeRoutes: { ...roster.modeRoutes, [mode]: routeId },
              }))}
            />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Execution profiles</p>
            <p className="text-xs text-muted-foreground">
              Each profile defines model capability, cost, fallback, and escalation—not the worker's task.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={() => updateSelectedRoster(addRoute)}
          >
            <Plus className="size-3.5" />
            Add execution profile
          </Button>
        </div>
        {selectedRoster.routes.map((route) => (
          <RouteEditor
            key={route.routeId}
            route={route}
            roster={selectedRoster}
            modelPresets={modelPresets}
            selectableModels={selectableModels}
            onChange={(nextRoute) => updateSelectedRoster((roster) => ({
              ...roster,
              routes: roster.routes.map((candidate) => (
                candidate.routeId === route.routeId ? nextRoute : candidate
              )),
            }))}
            onDelete={() => updateSelectedRoster((roster) => removeRoute(roster, route.routeId))}
          />
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
    </div>
  )
}

function RouteEditor({
  route,
  roster,
  modelPresets,
  selectableModels,
  onChange,
  onDelete,
}: {
  route: DelegationRoute
  roster: DelegationRoster
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
  onChange: (route: DelegationRoute) => void
  onDelete: () => void
}) {
  const supportedLevels = getSupportedReasoningLevelsForModelId(
    route.modelId,
    modelPresets,
    route.provider,
  )
  const fallbackLevels = route.availabilityFallback
    ? getSupportedReasoningLevelsForModelId(
        route.availabilityFallback.modelId,
        modelPresets,
        route.availabilityFallback.provider,
      )
    : MANAGER_REASONING_LEVELS

  return (
    <div className="space-y-4 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label className="text-xs text-muted-foreground">Execution profile name</Label>
          <Input
            value={route.label}
            onChange={(event) => onChange({ ...route, label: event.target.value })}
          />
          <p className="font-mono text-[11px] text-muted-foreground">{route.routeId}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          disabled={roster.routes.length <= 1}
          aria-label={`Delete ${route.label} execution profile`}
          className="mt-5 shrink-0"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Best for</Label>
          <Textarea
            value={route.useWhen}
            rows={2}
            onChange={(event) => onChange({ ...route, useWhen: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Avoid for</Label>
          <Textarea
            value={route.avoidWhen ?? ''}
            rows={2}
            placeholder="Optional"
            onChange={(event) => onChange({
              ...route,
              avoidWhen: event.target.value || undefined,
            })}
          />
        </div>
      </div>

      <div className="grid gap-3 border-t border-border/50 pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)]">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Primary model</Label>
          <ModelIdSelect
            modelId={route.modelId}
            provider={route.provider}
            models={selectableModels}
            presets={modelPresets}
            onValueChange={(model) => onChange({
              ...route,
              ...model,
              reasoningLevel: keepSupportedReasoning(
                route.reasoningLevel,
                getSupportedReasoningLevelsForModelId(
                  model.modelId,
                  modelPresets,
                  model.provider,
                ),
              ),
            })}
          />
        </div>
        <ReasoningSelect
          value={route.reasoningLevel}
          levels={supportedLevels}
          onChange={(reasoningLevel) => onChange({ ...route, reasoningLevel })}
        />
      </div>

      <div className="space-y-2 border-t border-border/50 pt-3">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Fallback model</Label>
            <ModelIdSelect
              modelId={route.availabilityFallback?.modelId ?? ''}
              provider={route.availabilityFallback?.provider ?? ''}
              models={selectableModels}
              presets={modelPresets}
              placeholder="None"
              allowNone
              onValueChange={(model) => onChange({
                ...route,
                availabilityFallback: model.modelId
                  ? {
                      ...model,
                      reasoningLevel: keepSupportedReasoning(
                        route.availabilityFallback?.reasoningLevel ?? route.reasoningLevel,
                        getSupportedReasoningLevelsForModelId(
                          model.modelId,
                          modelPresets,
                          model.provider,
                        ),
                      ),
                    }
                  : undefined,
              })}
            />
          </div>
          <ReasoningSelect
            label="Fallback reasoning"
            value={route.availabilityFallback?.reasoningLevel ?? route.reasoningLevel}
            levels={fallbackLevels}
            disabled={!route.availabilityFallback}
            onChange={(reasoningLevel) => {
              if (!route.availabilityFallback) return
              onChange({
                ...route,
                availabilityFallback: { ...route.availabilityFallback, reasoningLevel },
              })
            }}
          />
          <RouteSelect
            label="Escalates to"
            value={route.capabilityEscalationRouteId ?? '__none__'}
            roster={roster}
            allowNone
            excludeRouteId={route.routeId}
            onChange={(capabilityEscalationRouteId) => onChange({
              ...route,
              capabilityEscalationRouteId:
                capabilityEscalationRouteId === '__none__'
                  ? undefined
                  : capabilityEscalationRouteId,
            })}
          />
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Fallback changes models only when the primary model is unavailable. Escalation starts a
          new attempt with another execution profile after evidence that this profile was not capable
          enough.
        </p>
      </div>
    </div>
  )
}

function RouteSelect({
  label,
  value,
  roster,
  onChange,
  allowNone,
  excludeRouteId,
}: {
  label: string
  value: string
  roster: DelegationRoster
  onChange: (routeId: string) => void
  allowNone?: boolean
  excludeRouteId?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full min-w-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value="__none__">None</SelectItem>}
          {roster.routes
            .filter((route) => route.routeId !== excludeRouteId)
            .map((route) => (
              <SelectItem key={route.routeId} value={route.routeId}>
                {route.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ReasoningSelect({
  value,
  levels,
  onChange,
  label = 'Reasoning',
  disabled,
}: {
  value: ManagerReasoningLevel
  levels: readonly ManagerReasoningLevel[]
  onChange: (level: ManagerReasoningLevel) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(level) => onChange(level as ManagerReasoningLevel)}
      >
        <SelectTrigger className="w-full min-w-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {formatReasoningLevel(level, levels)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function addRoute(roster: DelegationRoster): DelegationRoster {
  const routeId = nextId('execution-profile', new Set(roster.routes.map((route) => route.routeId)))
  const source = roster.routes.find((route) => route.routeId === roster.defaultRouteId)
    ?? roster.routes[0]!
  return {
    ...roster,
    routes: [
      ...roster.routes,
      {
        ...cloneRoute(source),
        routeId,
        label: `Execution Profile ${roster.routes.length + 1}`,
        useWhen: 'Describe the work this profile handles well.',
        capabilityEscalationRouteId: undefined,
      },
    ],
  }
}

function removeRoute(roster: DelegationRoster, routeId: string): DelegationRoster {
  if (roster.routes.length <= 1) return roster
  const routes = roster.routes.filter((route) => route.routeId !== routeId)
  const replacement = routes[0]!.routeId
  const defaultRouteId = roster.defaultRouteId === routeId ? replacement : roster.defaultRouteId
  const modeRoutes = Object.fromEntries(
    Object.entries(roster.modeRoutes ?? {}).map(([mode, configuredRouteId]) => [
      mode,
      configuredRouteId === routeId ? defaultRouteId : configuredRouteId,
    ]),
  ) as DelegationRoster['modeRoutes']
  return {
    ...roster,
    routes: routes.map((route) => (
      route.capabilityEscalationRouteId === routeId
        ? { ...route, capabilityEscalationRouteId: undefined }
        : route
    )),
    defaultRouteId,
    modeRoutes,
  }
}

function cloneRoute(route: DelegationRoute): DelegationRoute {
  return {
    ...route,
    availabilityFallback: route.availabilityFallback
      ? { ...route.availabilityFallback }
      : undefined,
  }
}

function nextId(base: string, existing: Set<string>): string {
  const normalized = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'
  let candidate = normalized
  let suffix = 2
  while (existing.has(candidate)) {
    candidate = `${normalized}-${suffix}`
    suffix += 1
  }
  return candidate
}

function keepSupportedReasoning(
  current: ManagerReasoningLevel,
  supported: readonly ManagerReasoningLevel[],
): ManagerReasoningLevel {
  if (supported.includes(current)) return current
  if (supported.includes('medium')) return 'medium'
  return supported[0] ?? 'none'
}
