import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, Zap } from 'lucide-react'
import {
  getCatalogModel,
  MANAGER_REASONING_LEVELS,
  type ManagerReasoningLevel,
} from '@forge/protocol'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { fetchModelOverrides, type ModelOverridesResponse } from '@/components/settings/models-api'
import {
  buildCurrentModelFallbackRow,
  buildManagerModelRows,
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from '@/lib/manager-model-selection'
import { cn } from '@/lib/utils'
import { resolveSessionModelPickerApiClient } from './session-model-picker-target'
import type { SessionModelPickerConfig } from './types'

const REASONING_LEVEL_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
  'x-high': 'Max',
  max: 'Max',
  ultra: 'Ultra',
}

function formatReasoningLevel(level: string): string {
  const knownLabel = REASONING_LEVEL_LABELS[level]
  if (knownLabel) return knownLabel

  const words = level.replaceAll(/[-_]+/g, ' ').trim()
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : 'Default'
}

function asManagerReasoningLevel(level: string): ManagerReasoningLevel {
  if (level === 'x-high') return 'xhigh'
  return MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel)
    ? level as ManagerReasoningLevel
    : 'high'
}

export function SessionModelPicker({ config }: { config: SessionModelPickerConfig }) {
  const [open, setOpen] = useState(false)
  const [overridesData, setOverridesData] = useState<ModelOverridesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRevisionRef = useRef(0)

  useEffect(() => {
    loadRevisionRef.current += 1
    setOpen(false)
    setOverridesData(null)
    setError(null)
  }, [config.originId, config.sessionAgentId])

  const loadModels = () => {
    const revision = ++loadRevisionRef.current
    const apiClient = resolveSessionModelPickerApiClient(config.httpClientRef)
    if (!apiClient) {
      setError('Model settings are unavailable.')
      return
    }

    setLoading(true)
    setError(null)
    void fetchModelOverrides(apiClient)
      .then((data) => {
        if (loadRevisionRef.current !== revision) return
        setOverridesData(data)
      })
      .catch((loadError) => {
        if (loadRevisionRef.current !== revision) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load models.')
      })
      .finally(() => {
        if (loadRevisionRef.current === revision) setLoading(false)
      })
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) loadModels()
  }

  const currentKey = encodeManagerModelValue(
    config.currentModel.provider,
    config.currentModel.modelId,
  )
  const catalogModel = useMemo(
    () => getCatalogModel(config.currentModel.modelId, config.currentModel.provider),
    [config.currentModel.modelId, config.currentModel.provider],
  )
  const modelLabel = catalogModel?.displayName ?? config.currentModel.modelId
  const reasoning = asManagerReasoningLevel(config.currentModel.thinkingLevel)
  const reasoningLabel = formatReasoningLevel(config.currentModel.thinkingLevel)
  const effectiveLabel = `${modelLabel} · ${reasoningLabel}`
  const originLabel = config.modelOrigin === 'session_override' ? 'session override' : 'project default'

  const { selectableRows, groups } = useMemo(() => {
    if (!overridesData) return { selectableRows: [], groups: [] }

    const availableRows = buildManagerModelRows(
      'change',
      overridesData.overrides,
      overridesData.providerAvailability,
    ).filter((row) => !row.unavailableReason)
    const currentIsSelectable = availableRows.some((row) => row.key === currentKey)
    const rows = currentIsSelectable
      ? availableRows
      : [
          buildCurrentModelFallbackRow(
            config.currentModel.provider,
            config.currentModel.modelId,
            config.currentModel.thinkingLevel,
          ),
          ...availableRows,
        ]
    return {
      selectableRows: rows,
      groups: groupManagerModelRows(rows),
    }
  }, [
    config.currentModel.modelId,
    config.currentModel.provider,
    config.currentModel.thinkingLevel,
    currentKey,
    overridesData,
  ])

  const currentRow = selectableRows.find((row) => row.key === currentKey)
  const reasoningLevels = currentRow?.supportedReasoningLevels ?? [...MANAGER_REASONING_LEVELS]

  const runUpdate = async (update: () => void | Promise<void>) => {
    setSaving(true)
    setError(null)
    try {
      await update()
      setOpen(false)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
      setOpen(true)
    } finally {
      setSaving(false)
    }
  }

  const selectModel = (value: string) => {
    const selection = decodeManagerModelValue(value)
    const row = selectableRows.find((candidate) => candidate.key === value)
    if (!selection || !row || row.unavailableReason) return
    void runUpdate(() => config.onUpdate(
      config.sessionAgentId,
      'override',
      selection,
      row.defaultReasoningLevel,
    ))
  }

  const selectReasoning = (value: string) => {
    const level = asManagerReasoningLevel(value)
    void runUpdate(() => config.onUpdate(
      config.sessionAgentId,
      'override',
      {
        provider: config.currentModel.provider,
        modelId: config.currentModel.modelId,
      },
      level,
    ))
  }

  const profileDefaultLabel = config.profileDefaultModel
    ? getCatalogModel(
        config.profileDefaultModel.modelId,
        config.profileDefaultModel.provider,
      )?.displayName ?? config.profileDefaultModel.modelId
    : 'Project default'

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={config.disabled}
          className={cn(
            'flex h-7 min-w-0 max-w-[44vw] items-center gap-1 rounded-full border border-border/60 bg-muted/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors',
            'hover:border-border hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50 sm:max-w-56',
          )}
          aria-label={`Session model: ${modelLabel}, reasoning ${reasoningLabel}. Change session model.`}
          title={`${effectiveLabel} (${originLabel})`}
        >
          <Zap className="size-3 shrink-0 fill-current" aria-hidden="true" />
          <span className="truncate">{effectiveLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground">
          Session model
          {(loading || saving) && <Loader2 className="ml-auto size-3 animate-spin" />}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={loading || saving || !!error}>
            <span>Model</span>
            <span className="ml-auto max-w-28 truncate text-xs text-muted-foreground">
              {loading ? 'Loading…' : modelLabel}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className={cn(
              'max-h-[min(70vh,32rem)] w-64 overflow-y-auto',
              '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
              '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
              'hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/50',
              '[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]',
            )}
          >
            <DropdownMenuRadioGroup value={currentKey} onValueChange={selectModel}>
              {groups.map((group, index) => (
                <div key={group.provider}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {group.providerDisplayName}
                  </DropdownMenuLabel>
                  {group.rows.map((row) => (
                    <DropdownMenuRadioItem
                      key={row.key}
                      value={row.key}
                      disabled={saving || !!row.unavailableReason}
                    >
                      <span className="truncate">{row.displayName}</span>
                      {row.unavailableReason && (
                        <span className="ml-auto text-[10px] text-muted-foreground">Current</span>
                      )}
                    </DropdownMenuRadioItem>
                  ))}
                </div>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={loading || saving || !!error || !!currentRow?.unavailableReason}>
            <span>Reasoning</span>
            <span className="ml-auto text-xs text-muted-foreground">{reasoningLabel}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup value={reasoning} onValueChange={selectReasoning}>
              {reasoningLevels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level} disabled={saving}>
                  {formatReasoningLevel(level)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {config.modelOrigin === 'session_override' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={saving}
              onSelect={() => void runUpdate(() => config.onUpdate(
                config.sessionAgentId,
                'inherit',
              ))}
            >
              <span>Use project default</span>
              <span className="ml-auto max-w-24 truncate text-xs text-muted-foreground">
                {profileDefaultLabel}
              </span>
            </DropdownMenuItem>
          </>
        )}

        {error && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault()
                loadModels()
              }}
            >
              Could not load models · Retry
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
