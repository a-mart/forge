import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, RotateCcw } from 'lucide-react'
import {
  FORGE_MODEL_CATALOG,
  type ForgeModelDefinition,
  type ModelOverrideEntry,
} from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from './settings-row'
import {
  deleteModelOverride,
  fetchModelOverrides,
  resetAllModelOverrides,
  updateModelOverride,
} from './models-api'
import { cn } from '@/lib/utils'

const numberFormatter = new Intl.NumberFormat()

interface SettingsModelsProps {
  wsUrl: string
  modelConfigChangeKey: number
}

interface ProviderGroup {
  providerId: string
  displayName: string
  availabilityMode: 'managed-auth' | 'external'
  models: ForgeModelDefinition[]
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }

  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }

  return numberFormatter.format(value)
}

function getEffectiveContextWindow(model: ForgeModelDefinition, override?: ModelOverrideEntry): number {
  const cap = override?.contextWindowCap
  return cap !== undefined ? Math.min(model.contextWindow, cap) : model.contextWindow
}

function getEffectiveEnabled(model: ForgeModelDefinition, override?: ModelOverrideEntry): boolean {
  return override?.enabled ?? model.enabledByDefault
}

function hasOverrideField<K extends keyof ModelOverrideEntry>(
  override: ModelOverrideEntry | undefined,
  key: K,
): boolean {
  return override?.[key] !== undefined
}

function ProviderStatusBadge({
  availabilityMode,
  available,
}: {
  availabilityMode: 'managed-auth' | 'external'
  available: boolean | undefined
}) {
  if (availabilityMode === 'external') {
    return <Badge variant="outline">External</Badge>
  }

  return available ? (
    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
      Configured
    </Badge>
  ) : (
    <Badge variant="outline" className="border-border/60 bg-muted/40 text-muted-foreground">
      Not configured
    </Badge>
  )
}

function OverrideBadge({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
      Override
    </Badge>
  )
}

function ModelCard({
  wsUrl,
  model,
  familyDisplayName,
  override,
  expanded,
  onToggle,
  onRefresh,
}: {
  wsUrl: string
  model: ForgeModelDefinition
  familyDisplayName: string
  override?: ModelOverrideEntry
  expanded: boolean
  onToggle: () => void
  onRefresh: () => Promise<void>
}) {
  const [contextCapDraft, setContextCapDraft] = useState(override?.contextWindowCap?.toString() ?? '')
  const [isSavingEnabled, setIsSavingEnabled] = useState(false)
  const [isSavingCap, setIsSavingCap] = useState(false)
  const [isResettingAll, setIsResettingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enabled = getEffectiveEnabled(model, override)
  const effectiveContextWindow = getEffectiveContextWindow(model, override)
  const hasAnyOverride = Boolean(override && Object.keys(override).length > 0)

  useEffect(() => {
    setContextCapDraft(override?.contextWindowCap?.toString() ?? '')
  }, [model.modelId, override?.contextWindowCap])

  const saveEnabled = useCallback(
    async (checked: boolean) => {
      setError(null)
      setIsSavingEnabled(true)
      try {
        await updateModelOverride(wsUrl, model.modelId, {
          enabled: checked === model.enabledByDefault ? null : checked,
        })
        await onRefresh()
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError))
      } finally {
        setIsSavingEnabled(false)
      }
    },
    [model.enabledByDefault, model.modelId, onRefresh, wsUrl],
  )

  const applyContextCap = useCallback(async () => {
    setError(null)
    const trimmed = contextCapDraft.trim()

    let nextCap: number | null = null
    if (trimmed.length > 0) {
      const parsed = Number(trimmed)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError('Context window cap must be a positive integer.')
        return
      }
      nextCap = parsed >= model.contextWindow ? null : parsed
    }

    setIsSavingCap(true)
    try {
      await updateModelOverride(wsUrl, model.modelId, { contextWindowCap: nextCap })
      await onRefresh()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setIsSavingCap(false)
    }
  }, [contextCapDraft, model.contextWindow, model.modelId, onRefresh, wsUrl])

  const resetModel = useCallback(async () => {
    setError(null)
    setIsResettingAll(true)
    try {
      await deleteModelOverride(wsUrl, model.modelId)
      await onRefresh()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setIsResettingAll(false)
    }
  }, [model.modelId, onRefresh, wsUrl])

  return (
    <div className="rounded-lg border border-border/70 bg-card/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/30"
      >
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{model.displayName}</span>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {familyDisplayName}
            </Badge>
            {enabled ? null : <Badge variant="destructive">Disabled</Badge>}
            {hasAnyOverride ? <OverrideBadge active /> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Context {formatTokenCount(effectiveContextWindow)}</span>
            <span>Output {formatTokenCount(model.maxOutputTokens)}</span>
            <span>Reasoning {model.supportsReasoning ? 'Supported' : 'None'}</span>
          </div>
        </div>
        <div className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </div>
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-border/60 px-4 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>Enabled</span>
                <OverrideBadge active={hasOverrideField(override, 'enabled')} />
              </div>
              <p className="text-xs text-muted-foreground">
                Hide this model from selectors for new configuration changes.
              </p>
              <div className="flex items-center gap-3 pt-1">
                <Switch
                  checked={enabled}
                  onCheckedChange={saveEnabled}
                  disabled={isSavingEnabled || isResettingAll}
                  aria-label={`Enable ${model.displayName}`}
                />
                <span className="text-sm text-muted-foreground">{enabled ? 'Enabled' : 'Disabled'}</span>
                {isSavingEnabled ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => void updateModelOverride(wsUrl, model.modelId, { enabled: null }).then(onRefresh).catch((saveError) => setError(saveError instanceof Error ? saveError.message : String(saveError)))}
                  disabled={!hasOverrideField(override, 'enabled') || isSavingEnabled || isResettingAll}
                >
                  Reset
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>Context window cap</span>
                <OverrideBadge active={hasOverrideField(override, 'contextWindowCap')} />
              </div>
              <p className="text-xs text-muted-foreground">
                Built-in default {numberFormatter.format(model.contextWindow)} tokens. Caps only limit, never increase.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={contextCapDraft}
                  onChange={(event) => setContextCapDraft(event.target.value)}
                  placeholder={numberFormatter.format(model.contextWindow)}
                  className="w-44"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void applyContextCap()}
                  disabled={isSavingCap || isResettingAll}
                >
                  {isSavingCap ? <Loader2 className="size-4 animate-spin" /> : null}
                  Apply
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setContextCapDraft('')
                    void updateModelOverride(wsUrl, model.modelId, { contextWindowCap: null })
                      .then(onRefresh)
                      .catch((saveError) => setError(saveError instanceof Error ? saveError.message : String(saveError)))
                  }}
                  disabled={!hasOverrideField(override, 'contextWindowCap') || isSavingCap || isResettingAll}
                >
                  Reset
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
            <div>Effective context window: {numberFormatter.format(effectiveContextWindow)}</div>
            <div>Supported reasoning levels: {model.supportedReasoningLevels.join(', ')}</div>
            <div>Max output tokens: {numberFormatter.format(model.maxOutputTokens)}</div>
            <div>Input modes: {model.inputModes.join(', ')}</div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            <div className="text-xs text-muted-foreground">
              {hasAnyOverride ? 'User override active for this model.' : 'Using checked-in catalog defaults.'}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void resetModel()}
              disabled={!hasAnyOverride || isResettingAll || isSavingEnabled || isSavingCap}
            >
              {isResettingAll ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              Reset model
            </Button>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

export function SettingsModels({ wsUrl, modelConfigChangeKey }: SettingsModelsProps) {
  const [overrides, setOverrides] = useState<Record<string, ModelOverrideEntry>>({})
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedModelIds, setExpandedModelIds] = useState<Record<string, boolean>>({})
  const [resettingAll, setResettingAll] = useState(false)

  const loadOverrides = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const response = await fetchModelOverrides(wsUrl)
      setOverrides(response.overrides)
      setProviderAvailability(response.providerAvailability)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [wsUrl])

  useEffect(() => {
    void loadOverrides()
  }, [loadOverrides, modelConfigChangeKey])

  const providerGroups = useMemo<ProviderGroup[]>(() => {
    return Object.values(FORGE_MODEL_CATALOG.providers)
      .map((provider) => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        availabilityMode: provider.availabilityMode,
        models: Object.values(FORGE_MODEL_CATALOG.models).filter((model) => model.provider === provider.providerId),
      }))
      .filter((group) => group.models.length > 0)
  }, [])

  const hasAnyOverrides = Object.keys(overrides).length > 0

  const handleResetAll = useCallback(async () => {
    if (!hasAnyOverrides) return
    if (!window.confirm('Reset all model overrides?')) return

    setError(null)
    setResettingAll(true)
    try {
      await resetAllModelOverrides(wsUrl)
      await loadOverrides()
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError))
    } finally {
      setResettingAll(false)
    }
  }, [hasAnyOverrides, loadOverrides, wsUrl])

  return (
    <SettingsSection
      label="Models"
      description="Review the checked-in model catalog and apply local visibility or context-window caps without editing source code."
      cta={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleResetAll()}
          disabled={!hasAnyOverrides || resettingAll}
        >
          {resettingAll ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
          Reset all
        </Button>
      )}
    >
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading model overrides…
        </div>
      ) : null}

      <div className="space-y-4">
        {providerGroups.map((group) => (
          <div key={group.providerId} className="space-y-3 rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{group.displayName}</h3>
                <p className="text-xs text-muted-foreground">
                  {group.models.length} {group.models.length === 1 ? 'model' : 'models'}
                </p>
              </div>
              <ProviderStatusBadge
                availabilityMode={group.availabilityMode}
                available={providerAvailability[group.providerId]}
              />
            </div>

            <div className="space-y-2">
              {group.models.map((model) => {
                const familyDisplayName = FORGE_MODEL_CATALOG.families[
                  model.familyId as keyof typeof FORGE_MODEL_CATALOG.families
                ]?.displayName ?? model.familyId
                const override = overrides[model.modelId]

                return (
                  <ModelCard
                    key={model.modelId}
                    wsUrl={wsUrl}
                    model={model}
                    familyDisplayName={familyDisplayName}
                    override={override}
                    expanded={expandedModelIds[model.modelId] === true}
                    onToggle={() =>
                      setExpandedModelIds((current) => ({
                        ...current,
                        [model.modelId]: !current[model.modelId],
                      }))
                    }
                    onRefresh={loadOverrides}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {!loading && providerGroups.length === 0 ? (
        <div className={cn('text-sm text-muted-foreground')}>No models available.</div>
      ) : null}
    </SettingsSection>
  )
}
