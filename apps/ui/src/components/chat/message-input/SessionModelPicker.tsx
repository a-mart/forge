import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Zap } from 'lucide-react'
import {
  getCatalogModel,
  MANAGER_REASONING_LEVELS,
  type ManagerReasoningLevel,
  type SessionModelUpdateMode,
} from '@forge/protocol'
import { cn } from '@/lib/utils'
import { SessionModelDialog } from '../agent-sidebar/dialogs/SessionModelDialog'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
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

function asManagerReasoningLevel(level: string): ManagerReasoningLevel | undefined {
  return MANAGER_REASONING_LEVELS.includes(level as ManagerReasoningLevel)
    ? level as ManagerReasoningLevel
    : undefined
}

export function SessionModelPicker({ config }: { config: SessionModelPickerConfig }) {
  const [open, setOpen] = useState(false)
  const [dialogApiClient, setDialogApiClient] = useState<SettingsApiClient | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // An open dialog belongs to one origin/session. Never carry it across route
  // changes, including equal agent ids on different remote origins.
  useEffect(() => {
    setOpen(false)
    setDialogApiClient(null)
  }, [config.originId, config.sessionAgentId])

  const openDialog = () => {
    // Refs are updated by useOriginConnection before user events run, avoiding
    // both stale render-time reads and wsUrl-based target reconstruction.
    const apiClient = resolveSessionModelPickerApiClient(config.httpClientRef)
    if (!apiClient) return
    setDialogApiClient(apiClient)
    setOpen(true)
  }
  const catalogModel = useMemo(
    () => getCatalogModel(config.currentModel.modelId, config.currentModel.provider),
    [config.currentModel.modelId, config.currentModel.provider],
  )
  const modelLabel = catalogModel?.displayName ?? config.currentModel.modelId
  const reasoningLabel = formatReasoningLevel(config.currentModel.thinkingLevel)
  const effectiveLabel = `${modelLabel} · ${reasoningLabel}`
  const originLabel = config.modelOrigin === 'session_override' ? 'session override' : 'project default'

  const handleUpdate = (
    sessionAgentId: string,
    mode: SessionModelUpdateMode,
    modelSelection?: Parameters<SessionModelPickerConfig['onUpdate']>[2],
    reasoningLevel?: Parameters<SessionModelPickerConfig['onUpdate']>[3],
  ) => {
    if (mode === 'inherit') {
      void config.onUpdate(sessionAgentId, mode)
    } else {
      void config.onUpdate(sessionAgentId, mode, modelSelection, reasoningLevel)
    }
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={config.disabled}
        onClick={openDialog}
        className={cn(
          'flex h-7 min-w-0 max-w-[44vw] items-center gap-1 rounded-full border border-border/60 bg-muted/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors',
          'hover:border-border hover:bg-muted hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50 sm:max-w-56',
        )}
        aria-label={`Session model: ${modelLabel}, reasoning ${reasoningLabel}. Change session model.`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${effectiveLabel} (${originLabel})`}
      >
        <Zap className="size-3 shrink-0 fill-current" aria-hidden="true" />
        <span className="truncate">{effectiveLabel}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>

      {open && dialogApiClient ? (
        <SessionModelDialog
          apiClient={dialogApiClient}
          sessionAgentId={config.sessionAgentId}
          sessionLabel={config.sessionLabel}
          currentModel={config.currentModel}
          currentReasoningLevel={asManagerReasoningLevel(config.currentModel.thinkingLevel)}
          modelOrigin={config.modelOrigin}
          profileDefaultModel={config.profileDefaultModel}
          onConfirm={handleUpdate}
          onClose={() => setOpen(false)}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </>
  )
}
