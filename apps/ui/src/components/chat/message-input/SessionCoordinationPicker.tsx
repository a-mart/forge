import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, GitBranch } from 'lucide-react'
import type { ManagerPosture } from '@forge/protocol'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fetchDelegationRosterSettings } from '@/components/settings/specialists-api'
import { cn } from '@/lib/utils'
import { resolveSessionModelPickerApiClient } from './session-model-picker-target'
import type { SessionCoordinationPickerConfig } from './types'

interface RosterOption {
  rosterId: string
  name: string
}

export function SessionCoordinationPicker({
  config,
}: {
  config: SessionCoordinationPickerConfig
}) {
  const [open, setOpen] = useState(false)
  const [rosters, setRosters] = useState<RosterOption[]>([])
  const [globalRosterId, setGlobalRosterId] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRevisionRef = useRef(0)

  useEffect(() => {
    loadRevisionRef.current += 1
    setOpen(false)
    setRosters([])
    setGlobalRosterId('')
    setError(null)
  }, [config.originId, config.sessionAgentId])

  const loadRosters = () => {
    const revision = ++loadRevisionRef.current
    const client = resolveSessionModelPickerApiClient(config.httpClientRef)
    if (!client) {
      setError('Settings connection is unavailable.')
      return
    }

    setLoading(true)
    setError(null)
    void fetchDelegationRosterSettings(client)
      .then((settings) => {
        if (loadRevisionRef.current !== revision) return
        setRosters(settings.rosters.map((roster) => ({
          rosterId: roster.rosterId,
          name: roster.name,
        })))
        setGlobalRosterId(settings.defaultRosterId)
      })
      .catch((loadError) => {
        if (loadRevisionRef.current !== revision) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (loadRevisionRef.current === revision) setLoading(false)
      })
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) loadRosters()
  }

  const projectPosture = config.projectDefaultManagerPosture ?? 'delegation_first'
  const projectRosterId = config.projectDefaultDelegationRosterId ?? globalRosterId
  const currentRosterId = config.delegationRosterId ?? projectRosterId
  const currentRosterLabel = useMemo(
    () => rosterLabel(rosters, currentRosterId),
    [currentRosterId, rosters],
  )
  const [selectedPosture, setSelectedPosture] = useState<ManagerPosture>(config.managerPosture)
  const [selectedRosterId, setSelectedRosterId] = useState(currentRosterId)
  const postureLabel = formatPosture(selectedPosture)

  useEffect(() => {
    setSelectedPosture(config.managerPosture)
  }, [config.managerPosture])

  useEffect(() => {
    setSelectedRosterId(currentRosterId)
  }, [currentRosterId])

  const runUpdate = async (
    update: () => void | Promise<void>,
    rollback?: () => void,
  ) => {
    setSaving(true)
    setError(null)
    try {
      await update()
    } catch (updateError) {
      rollback?.()
      setError(updateError instanceof Error ? updateError.message : String(updateError))
      setOpen(true)
    } finally {
      setSaving(false)
    }
  }

  const selectPosture = (value: string) => {
    const posture = value as ManagerPosture
    const previousPosture = selectedPosture
    setSelectedPosture(posture)
    void runUpdate(
      () => config.onUpdateSession(config.sessionAgentId, {
        managerPosture: posture === projectPosture
          ? { mode: 'inherit' }
          : { mode: 'override', value: posture },
      }),
      () => setSelectedPosture(previousPosture),
    )
  }

  const selectRoster = (rosterId: string) => {
    const previousRosterId = selectedRosterId
    setSelectedRosterId(rosterId)
    void runUpdate(
      () => config.onUpdateSession(config.sessionAgentId, {
        delegationRoster: rosterId === projectRosterId
          ? { mode: 'inherit' }
          : { mode: 'override', rosterId },
      }),
      () => setSelectedRosterId(previousRosterId),
    )
  }

  const makePostureProjectDefault = () => {
    const posture = selectedPosture
    void runUpdate(async () => {
      await config.onUpdateProjectDefaults(config.profileId, { managerPosture: posture })
      await config.onUpdateSession(config.sessionAgentId, {
        managerPosture: { mode: 'inherit' },
      })
    })
  }

  const makeRosterProjectDefault = () => {
    if (!selectedRosterId) return
    void runUpdate(async () => {
      await config.onUpdateProjectDefaults(config.profileId, {
        delegationRosterId: selectedRosterId,
      })
      await config.onUpdateSession(config.sessionAgentId, {
        delegationRoster: { mode: 'inherit' },
      })
    })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={config.disabled}
          className={cn(
            'flex h-7 min-w-0 max-w-[38vw] items-center gap-1 rounded-full border border-border/60 bg-muted/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors',
            'hover:border-border hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50 sm:max-w-44',
          )}
          aria-label={`Work mode: ${formatPosture(config.managerPosture)}. Roster: ${currentRosterLabel}.`}
          title={`${formatPosture(config.managerPosture)} · ${currentRosterLabel}`}
        >
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{formatPosture(config.managerPosture)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 space-y-3 p-2"
        aria-label="Session work settings"
      >
        <fieldset className="space-y-1.5" disabled={saving}>
          <legend className="sr-only">Work mode</legend>
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Work mode
            </span>
            {saving && (
              <span className="text-[10px] text-muted-foreground" aria-live="polite">
                Saving…
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-muted/65 p-1">
            {(['delegation_first', 'adaptive', 'hands_on'] as const).map((posture) => {
              const selected = selectedPosture === posture
              const isProjectDefault = posture === projectPosture
              return (
                <label
                  key={posture}
                  className={cn(
                    'flex min-h-10 cursor-pointer flex-col items-center justify-center rounded-sm px-2 py-1 text-center transition-colors',
                    'hover:bg-background/65',
                    'has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    selected
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-emerald-500/45'
                      : 'text-muted-foreground',
                    saving && 'pointer-events-none opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name={`work-mode-${config.sessionAgentId}`}
                    value={posture}
                    checked={selected}
                    disabled={saving}
                    onChange={(event) => selectPosture(event.currentTarget.value)}
                    className="sr-only"
                  />
                  <span className="text-xs font-medium">{formatPosture(posture)}</span>
                  {isProjectDefault && <DefaultSuffix compact />}
                </label>
              )
            })}
          </div>
          {selectedPosture !== projectPosture ? (
            <InlineAction
              disabled={saving}
              onClick={makePostureProjectDefault}
            >
              Make {postureLabel} project default
            </InlineAction>
          ) : config.managerPostureOrigin === 'session_override' ? (
            <InlineAction
              disabled={saving}
              onClick={() => void runUpdate(() => config.onUpdateSession(
                config.sessionAgentId,
                { managerPosture: { mode: 'inherit' } },
              ))}
            >
              Use project default
            </InlineAction>
          ) : null}
        </fieldset>

        <div className="h-px bg-border/75" />

        <fieldset className="space-y-1.5" disabled={loading || saving || !!error}>
          <legend className="sr-only">Roster</legend>
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Roster
            </span>
            {loading && (
              <span className="text-[10px] text-muted-foreground" aria-live="polite">
                Loading…
              </span>
            )}
          </div>

          {!loading && rosters.length === 1 ? (
            <div className="flex min-h-9 items-center rounded-md border border-border/60 bg-muted/35 px-2.5">
              <span className="truncate text-xs font-medium text-foreground">
                {rosters[0]?.name}
              </span>
              {rosters[0]?.rosterId === projectRosterId && <DefaultSuffix />}
            </div>
          ) : (
            <div className="space-y-1">
              {rosters.map((roster) => {
                const selected = selectedRosterId === roster.rosterId
                return (
                  <label
                    key={roster.rosterId}
                    className={cn(
                      'flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2.5 transition-colors',
                      'hover:bg-accent/70 has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      selected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
                      saving && 'pointer-events-none opacity-60',
                    )}
                  >
                    <input
                      type="radio"
                      name={`worker-roster-${config.sessionAgentId}`}
                      value={roster.rosterId}
                      checked={selected}
                      disabled={saving}
                      onChange={(event) => selectRoster(event.currentTarget.value)}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-full border',
                        selected
                          ? 'border-foreground/50 bg-background/80'
                          : 'border-border',
                      )}
                      aria-hidden="true"
                    >
                      {selected && <Check className="size-2.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {roster.name}
                    </span>
                    {roster.rosterId === projectRosterId && <DefaultSuffix />}
                  </label>
                )
              })}
            </div>
          )}

          {!loading && selectedRosterId !== projectRosterId ? (
            <InlineAction
              disabled={saving}
              onClick={makeRosterProjectDefault}
            >
              Make {rosterLabel(rosters, selectedRosterId)} project default
            </InlineAction>
          ) : config.delegationRosterOrigin === 'session_override' ? (
            <InlineAction
              disabled={saving}
              onClick={() => void runUpdate(() => config.onUpdateSession(
                config.sessionAgentId,
                { delegationRoster: { mode: 'inherit' } },
              ))}
            >
              Use project default
            </InlineAction>
          ) : null}
        </fieldset>

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            <span className="min-w-0 flex-1 truncate">{error}</span>
            <button
              type="button"
              className="shrink-0 font-medium underline-offset-2 hover:underline"
              onClick={loadRosters}
            >
              Reload choices
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function InlineAction({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full px-1 text-right text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function DefaultSuffix({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        'text-[10px] text-muted-foreground',
        compact ? 'leading-tight' : 'ml-auto',
      )}
    >
      Project default
    </span>
  )
}

function formatPosture(posture: ManagerPosture): string {
  if (posture === 'hands_on') return 'Hands-on'
  if (posture === 'adaptive') return 'Adaptive'
  return 'Delegate first'
}

function rosterLabel(rosters: RosterOption[], rosterId: string): string {
  return rosters.find((roster) => roster.rosterId === rosterId)?.name
    ?? rosterId
    ?? 'Default roster'
}
