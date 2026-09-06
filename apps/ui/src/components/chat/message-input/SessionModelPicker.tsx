import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Loader2, Zap } from 'lucide-react'
import {
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
import {
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from '@/lib/manager-model-selection'
import {
  buildCatalogCurrentModelFallbackRow,
  catalogModelLabel,
  catalogReasoningLevels,
  projectSelectableManagerModelRows,
} from '@/lib/manager-selection-catalog'
import { useManagerSelectionCatalog } from '@/lib/use-manager-selection-catalog'
import { cn } from '@/lib/utils'
import { formatReasoningLevel } from '@/lib/reasoning-level-labels'
import type { SessionModelPickerConfig } from './types'

function asManagerReasoningLevel(level: string): ManagerReasoningLevel {
  if (level === 'x-high') return 'xhigh'
  return MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel)
    ? level as ManagerReasoningLevel
    : 'high'
}

export function SessionModelPicker({ config }: { config: SessionModelPickerConfig }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const { catalog, loading, error: loadError, refetch } = useManagerSelectionCatalog({
    originId: config.originId,
    httpClientRef: config.httpClientRef,
    modelConfigChangeKey: config.modelConfigChangeKey,
    connectionEpoch: config.connectionEpoch,
  })
  const error = updateError ?? loadError

  useEffect(() => {
    setOpen(false)
    setUpdateError(null)
  }, [config.originId, config.sessionAgentId])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) refetch(true)
  }

  const currentKey = encodeManagerModelValue(
    config.currentModel.provider,
    config.currentModel.modelId,
  )
  const modelLabel = catalogModelLabel(
    catalog,
    config.currentModel.provider,
    config.currentModel.modelId,
  )
  const currentReasoningLevels = catalogReasoningLevels(
    catalog,
    config.currentModel.provider,
    config.currentModel.modelId,
  )
  const reasoning = asManagerReasoningLevel(config.currentModel.thinkingLevel)
  const reasoningLabel = formatReasoningLevel(
    config.currentModel.thinkingLevel,
    currentReasoningLevels,
  )
  const effectiveLabel = `${modelLabel} · ${reasoningLabel}`
  const originLabel = config.modelOrigin === 'session_override' ? 'session override' : 'selected from project default'
  const canUseProjectDefault = config.modelOrigin === 'session_override' || Boolean(config.profileDefaultModel && (
    config.currentModel.provider !== config.profileDefaultModel.provider ||
    config.currentModel.modelId !== config.profileDefaultModel.modelId ||
    config.currentModel.thinkingLevel !== config.profileDefaultModel.thinkingLevel
  ))

  const { selectableRows, groups } = useMemo(() => {
    if (!catalog) return { selectableRows: [], groups: [] }

    const availableRows = projectSelectableManagerModelRows(catalog, 'change')
    const currentIsSelectable = availableRows.some((row) => row.key === currentKey)
    const rows = currentIsSelectable
      ? availableRows
      : [
          buildCatalogCurrentModelFallbackRow(
            catalog,
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
    catalog,
    config.currentModel.modelId,
    config.currentModel.provider,
    config.currentModel.thinkingLevel,
    currentKey,
  ])

  const currentRow = selectableRows.find((row) => row.key === currentKey)
  const reasoningLevels = currentRow?.supportedReasoningLevels
    ?? currentReasoningLevels
    ?? [...MANAGER_REASONING_LEVELS]

  const runUpdate = async (update: () => void | Promise<void>) => {
    setSaving(true)
    setUpdateError(null)
    try {
      await update()
    } catch (caught) {
      setUpdateError(caught instanceof Error ? caught.message : String(caught))
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
    ? catalogModelLabel(
        catalog,
        config.profileDefaultModel.provider,
        config.profileDefaultModel.modelId,
      )
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
                      onSelect={(event) => event.preventDefault()}
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
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  disabled={saving}
                  onSelect={(event) => event.preventDefault()}
                >
                  {formatReasoningLevel(level, reasoningLevels)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {canUseProjectDefault && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={saving}
              onSelect={(event) => {
                event.preventDefault()
                void runUpdate(() => config.onUpdate(
                  config.sessionAgentId,
                  'inherit',
                ))
              }}
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
                refetch(true)
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
