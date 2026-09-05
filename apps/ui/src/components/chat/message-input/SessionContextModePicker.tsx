import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import {
  DEFAULT_CONTEXT_MODE,
  type ContextMode,
  type SessionContextModeSnapshot,
} from '@forge/protocol'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CONTEXT_MODE_APPLIES_LATER,
  CONTEXT_MODE_OPTION_LABELS,
  inheritChoiceLabel,
  sessionContextModeChoice,
  sessionContextOriginLabel,
  sessionContextStatusLabel,
  type SessionContextModeChoice,
} from '@/components/settings/context-mode-copy'
import {
  fetchSessionContextMode,
  updateSessionContextMode,
} from '@/components/settings/context-mode-api'
import { resolveSessionModelPickerApiClient } from './session-model-picker-target'
import type { SessionContextModePickerConfig } from './types'

export function SessionContextModePicker({
  config,
}: {
  config: SessionContextModePickerConfig
}) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<SessionContextModeSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scopeIdRef = useRef(0)
  const savingRef = useRef(false)

  const isCurrentScope = (scopeId: number) => scopeIdRef.current === scopeId

  const loadSnapshot = (scopeId = scopeIdRef.current) => {
    const client = resolveSessionModelPickerApiClient(config.httpClientRef)
    if (!client) {
      if (!isCurrentScope(scopeId)) return
      setError('Settings connection is unavailable.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void fetchSessionContextMode(client, config.sessionAgentId)
      .then((next) => {
        if (!isCurrentScope(scopeId) || savingRef.current) return
        setSnapshot(next)
      })
      .catch((loadError) => {
        if (!isCurrentScope(scopeId)) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!isCurrentScope(scopeId)) return
        setLoading(false)
      })
  }

  useEffect(() => {
    const scopeId = ++scopeIdRef.current
    savingRef.current = false
    setOpen(false)
    setSnapshot(null)
    setError(null)
    setLoading(false)
    setSaving(false)
    loadSnapshot(scopeId)
    return () => {
      if (scopeIdRef.current === scopeId) scopeIdRef.current += 1
      savingRef.current = false
    }
    // Reload when the session, origin, connection, or client changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.httpClientRef, config.originId, config.sessionAgentId, config.connectionEpoch])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) loadSnapshot()
  }

  const currentSnapshot = snapshot
  const projectDefault = currentSnapshot?.projectDefault ?? DEFAULT_CONTEXT_MODE
  const effectiveMode = currentSnapshot?.effectiveMode ?? projectDefault
  const freshSupported = currentSnapshot?.freshSupported ?? true
  const unsupportedReason = currentSnapshot?.unsupportedReason
  const selectedChoice = sessionContextModeChoice(currentSnapshot)
  const triggerLabel = CONTEXT_MODE_OPTION_LABELS[effectiveMode]
  const originLabel = sessionContextOriginLabel(currentSnapshot)
  const statusLabel = currentSnapshot
    ? sessionContextStatusLabel(currentSnapshot)
    : loading
      ? 'Loading context management…'
      : 'Context management'

  const selectChoice = (choice: SessionContextModeChoice) => {
    if (saving || choice === selectedChoice) return
    if (choice === 'fresh' && !freshSupported) return
    const client = resolveSessionModelPickerApiClient(config.httpClientRef)
    if (!client) {
      setError('Settings connection is unavailable.')
      setOpen(true)
      return
    }
    const previous = currentSnapshot
    const nextMode: ContextMode | null = choice === 'inherit' ? null : choice
    const optimistic: SessionContextModeSnapshot | null = previous
      ? {
          ...previous,
          sessionOverride: nextMode ?? undefined,
          effectiveMode: nextMode ?? previous.projectDefault,
        }
      : previous
    if (optimistic) {
      if (nextMode === null) delete optimistic.sessionOverride
      setSnapshot(optimistic)
    }
    const scopeId = scopeIdRef.current
    savingRef.current = true
    setSaving(true)
    setError(null)
    void updateSessionContextMode(client, config.sessionAgentId, nextMode)
      .then((next) => {
        if (!isCurrentScope(scopeId)) return
        setSnapshot(next)
      })
      .catch((saveError) => {
        if (!isCurrentScope(scopeId)) return
        setSnapshot(previous)
        setError(saveError instanceof Error ? saveError.message : String(saveError))
        setOpen(true)
      })
      .finally(() => {
        if (!isCurrentScope(scopeId)) return
        savingRef.current = false
        setSaving(false)
      })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={config.disabled}
          className={cn(
            'flex h-7 min-w-0 max-w-[42vw] items-center gap-1 rounded-full border border-border/60 bg-muted/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors',
            'hover:border-border hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50 sm:max-w-52',
          )}
          aria-label={`Context management: ${triggerLabel}. ${originLabel}.`}
          title={`${triggerLabel} (${originLabel})`}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 space-y-3 p-2"
        aria-label="Session context management"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <fieldset className="space-y-1.5" disabled={saving || loading}>
          <legend className="sr-only">Context management</legend>
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Context management
            </span>
            {(loading || saving) && (
              <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
            )}
          </div>
          <p className="px-1 text-[11px] leading-snug text-muted-foreground" aria-live="polite">
            {statusLabel}
          </p>
          <div className="grid gap-1 rounded-md bg-muted/65 p-1">
            <ChoiceOption
              name={`context-mode-${config.sessionAgentId}`}
              value="inherit"
              label={inheritChoiceLabel(projectDefault)}
              selected={selectedChoice === 'inherit'}
              disabled={saving || loading}
              onSelect={() => selectChoice('inherit')}
            />
            <ChoiceOption
              name={`context-mode-${config.sessionAgentId}`}
              value="summary"
              label={CONTEXT_MODE_OPTION_LABELS.summary}
              selected={selectedChoice === 'summary'}
              disabled={saving || loading}
              onSelect={() => selectChoice('summary')}
            />
            <ChoiceOption
              name={`context-mode-${config.sessionAgentId}`}
              value="fresh"
              label={CONTEXT_MODE_OPTION_LABELS.fresh}
              selected={selectedChoice === 'fresh'}
              disabled={saving || loading || !freshSupported}
              onSelect={() => selectChoice('fresh')}
              hint={!freshSupported ? unsupportedReason ?? 'Fresh windows are not supported for this session.' : undefined}
            />
          </div>
          <p className="px-1 text-[10px] leading-snug text-muted-foreground">
            {CONTEXT_MODE_APPLIES_LATER}
          </p>
        </fieldset>
        {!freshSupported && unsupportedReason ? (
          <p className="px-1 text-[11px] leading-snug text-amber-800 dark:text-amber-200" role="status">
            {unsupportedReason}
          </p>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              className="shrink-0 font-medium underline-offset-2 hover:underline"
              onClick={() => loadSnapshot()}
            >
              Retry
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function ChoiceOption({
  name,
  value,
  label,
  selected,
  disabled,
  onSelect,
  hint,
}: {
  name: string
  value: SessionContextModeChoice
  label: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
  hint?: string
}) {
  return (
    <label
      className={cn(
        'flex min-h-9 cursor-pointer flex-col justify-center rounded-sm px-2.5 py-1.5 transition-colors',
        'hover:bg-background/65 has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        selected ? 'bg-background text-foreground shadow-sm ring-1 ring-emerald-500/45' : 'text-muted-foreground',
        disabled && 'pointer-events-none cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        onClick={(event) => event.stopPropagation()}
        className="sr-only"
      />
      <span className="text-xs font-medium">{label}</span>
      {hint ? <span className="text-[10px] leading-tight text-muted-foreground">{hint}</span> : null}
    </label>
  )
}
