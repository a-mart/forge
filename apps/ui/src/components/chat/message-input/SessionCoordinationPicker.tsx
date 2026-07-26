import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, GitBranch, Loader2 } from 'lucide-react'
import type { ManagerPosture } from '@forge/protocol'
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
  const postureLabel = formatPosture(config.managerPosture)

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

  const selectPosture = (value: string) => {
    const posture = value as ManagerPosture
    void runUpdate(() => config.onUpdateSession(config.sessionAgentId, {
      managerPosture: posture === projectPosture
        ? { mode: 'inherit' }
        : { mode: 'override', value: posture },
    }))
  }

  const selectRoster = (rosterId: string) => {
    void runUpdate(() => config.onUpdateSession(config.sessionAgentId, {
      delegationRoster: rosterId === projectRosterId
        ? { mode: 'inherit' }
        : { mode: 'override', rosterId },
    }))
  }

  const makePostureProjectDefault = () => {
    const posture = config.managerPosture
    void runUpdate(async () => {
      await config.onUpdateProjectDefaults(config.profileId, { managerPosture: posture })
      await config.onUpdateSession(config.sessionAgentId, {
        managerPosture: { mode: 'inherit' },
      })
    })
  }

  const makeRosterProjectDefault = () => {
    if (!currentRosterId) return
    void runUpdate(async () => {
      await config.onUpdateProjectDefaults(config.profileId, {
        delegationRosterId: currentRosterId,
      })
      await config.onUpdateSession(config.sessionAgentId, {
        delegationRoster: { mode: 'inherit' },
      })
    })
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={config.disabled}
          className={cn(
            'flex h-7 min-w-0 max-w-[38vw] items-center gap-1 rounded-full border border-border/60 bg-muted/55 px-2 text-[11px] font-medium text-muted-foreground transition-colors',
            'hover:border-border hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50 sm:max-w-44',
          )}
          aria-label={`Coordination: ${postureLabel}, ${currentRosterLabel}`}
          title={`${postureLabel} · ${currentRosterLabel}`}
        >
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{postureLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground">
          Coordination
          {(loading || saving) && <Loader2 className="ml-auto size-3 animate-spin" />}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={saving}>
            <span>Manager posture</span>
            <span className="ml-auto max-w-28 truncate text-xs text-muted-foreground">
              {postureLabel}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            <DropdownMenuRadioGroup
              value={config.managerPosture}
              onValueChange={selectPosture}
            >
              {(['delegation_first', 'hands_on'] as const).map((posture) => (
                <DropdownMenuRadioItem key={posture} value={posture} disabled={saving}>
                  <span>{formatPosture(posture)}</span>
                  {posture === projectPosture && <DefaultSuffix />}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {config.managerPostureOrigin === 'session_override' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={saving}
                  onSelect={() => void runUpdate(() => config.onUpdateSession(
                    config.sessionAgentId,
                    { managerPosture: { mode: 'inherit' } },
                  ))}
                >
                  Use project default
                </DropdownMenuItem>
              </>
            )}
            {config.managerPosture !== projectPosture && (
              <DropdownMenuItem disabled={saving} onSelect={makePostureProjectDefault}>
                Make {postureLabel} project default
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={loading || saving || !!error}>
            <span>Delegation roster</span>
            <span className="ml-auto max-w-24 truncate text-xs text-muted-foreground">
              {loading ? 'Loading…' : currentRosterLabel}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <DropdownMenuRadioGroup value={currentRosterId} onValueChange={selectRoster}>
              {rosters.map((roster) => (
                <DropdownMenuRadioItem
                  key={roster.rosterId}
                  value={roster.rosterId}
                  disabled={saving}
                >
                  <span className="truncate">{roster.name}</span>
                  {roster.rosterId === projectRosterId && <DefaultSuffix />}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {config.delegationRosterOrigin === 'session_override' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={saving}
                  onSelect={() => void runUpdate(() => config.onUpdateSession(
                    config.sessionAgentId,
                    { delegationRoster: { mode: 'inherit' } },
                  ))}
                >
                  Use project default
                </DropdownMenuItem>
              </>
            )}
            {currentRosterId && currentRosterId !== projectRosterId && (
              <DropdownMenuItem disabled={saving} onSelect={makeRosterProjectDefault}>
                Make {currentRosterLabel} project default
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {error && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault()
                loadRosters()
              }}
            >
              Could not load rosters · Retry
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DefaultSuffix() {
  return (
    <span className="ml-auto text-[10px] text-muted-foreground">
      Project default
    </span>
  )
}

function formatPosture(posture: ManagerPosture): string {
  return posture === 'hands_on' ? 'Hands-on' : 'Delegation-first'
}

function rosterLabel(rosters: RosterOption[], rosterId: string): string {
  return rosters.find((roster) => roster.rosterId === rosterId)?.name
    ?? rosterId
    ?? 'Default roster'
}
