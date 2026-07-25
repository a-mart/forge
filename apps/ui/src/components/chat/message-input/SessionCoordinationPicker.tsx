import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, GitBranch, Loader2 } from 'lucide-react'
import type { ManagerPosture } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fetchDelegationRosterSettings } from '@/components/settings/specialists-api'
import { cn } from '@/lib/utils'
import { resolveSessionModelPickerApiClient } from './session-model-picker-target'
import type { SessionCoordinationPickerConfig } from './types'

const INHERIT = '__inherit__'

export function SessionCoordinationPicker({
  config,
}: {
  config: SessionCoordinationPickerConfig
}) {
  const [open, setOpen] = useState(false)
  const [posture, setPosture] = useState<string>(INHERIT)
  const [rosterId, setRosterId] = useState(INHERIT)
  const [makePostureProjectDefault, setMakePostureProjectDefault] = useState(false)
  const [makeRosterProjectDefault, setMakeRosterProjectDefault] = useState(false)
  const [rosters, setRosters] = useState<Array<{ rosterId: string; name: string }>>([])
  const [globalRosterId, setGlobalRosterId] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOpen(false)
  }, [config.originId, config.sessionAgentId])

  useEffect(() => {
    if (!open) return
    setPosture(
      config.managerPostureOrigin === 'session_override'
        ? config.managerPosture
        : INHERIT,
    )
    setRosterId(
      config.delegationRosterOrigin === 'session_override' && config.delegationRosterId
        ? config.delegationRosterId
        : INHERIT,
    )
    setMakePostureProjectDefault(false)
    setMakeRosterProjectDefault(false)
    setError(null)

    const client = resolveSessionModelPickerApiClient(config.httpClientRef)
    if (!client) {
      setError('Settings connection is unavailable.')
      return
    }
    let cancelled = false
    setLoading(true)
    fetchDelegationRosterSettings(client)
      .then((settings) => {
        if (cancelled) return
        setRosters(settings.rosters.map((roster) => ({
          rosterId: roster.rosterId,
          name: roster.name,
        })))
        setGlobalRosterId(settings.defaultRosterId)
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    config.delegationRosterId,
    config.delegationRosterOrigin,
    config.httpClientRef,
    config.managerPosture,
    config.managerPostureOrigin,
    open,
  ])

  const currentRosterLabel = useMemo(
    () => rosters.find((roster) => roster.rosterId === config.delegationRosterId)?.name
      ?? config.delegationRosterId
      ?? 'Default roster',
    [config.delegationRosterId, rosters],
  )
  const postureLabel = config.managerPosture === 'hands_on' ? 'Hands-on' : 'Delegate'

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const projectUpdates = {
        ...(makePostureProjectDefault && posture !== INHERIT
          ? { managerPosture: posture as ManagerPosture }
          : {}),
        ...(makeRosterProjectDefault && rosterId !== INHERIT
          ? { delegationRosterId: rosterId }
          : {}),
      }
      if (Object.keys(projectUpdates).length > 0) {
        await config.onUpdateProjectDefaults(config.profileId, projectUpdates)
      }
      await config.onUpdateSession(config.sessionAgentId, {
        managerPosture: makePostureProjectDefault || posture === INHERIT
          ? { mode: 'inherit' }
          : { mode: 'override', value: posture as ManagerPosture },
        delegationRoster: makeRosterProjectDefault || rosterId === INHERIT
          ? { mode: 'inherit' }
          : { mode: 'override', rosterId },
      })
      setOpen(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
          aria-label={`Coordination: ${postureLabel}, ${currentRosterLabel}`}
          title={`${postureLabel} · ${currentRosterLabel}`}
        >
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{postureLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] space-y-4">
        <PopoverHeader>
          <PopoverTitle>Session coordination</PopoverTitle>
          <PopoverDescription>
            Choose who leads the work and which model routes are available to workers.
          </PopoverDescription>
        </PopoverHeader>

        <div className="space-y-2">
          <Label className="text-xs">Manager posture</Label>
          <Select
            value={posture}
            onValueChange={(value) => {
              setPosture(value)
              setMakePostureProjectDefault(false)
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                Project default · {formatPosture(
                  config.projectDefaultManagerPosture ?? 'delegation_first',
                )}
              </SelectItem>
              <SelectItem value="delegation_first">Delegation-first</SelectItem>
              <SelectItem value="hands_on">Hands-on</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Hands-on asks the manager to do bounded work itself, while retaining delegation for
            parallelism, independence, or missing capability.
          </p>
          {posture !== INHERIT && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={makePostureProjectDefault}
                onCheckedChange={(checked) => setMakePostureProjectDefault(checked === true)}
              />
              Use {formatPosture(posture as ManagerPosture)} by default for this project
            </label>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Delegation roster</Label>
          <Select
            value={rosterId}
            disabled={loading}
            onValueChange={(value) => {
              setRosterId(value)
              setMakeRosterProjectDefault(false)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={loading ? 'Loading rosters…' : 'Select roster'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>
                Project default · {projectRosterLabel(
                  rosters,
                  config.projectDefaultDelegationRosterId ?? globalRosterId,
                )}
              </SelectItem>
              {rosters.map((roster) => (
                <SelectItem key={roster.rosterId} value={roster.rosterId}>
                  {roster.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Roster changes apply to future worker attempts. Running attempts keep their selected
            model and fallback.
          </p>
          {rosterId !== INHERIT && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={makeRosterProjectDefault}
                onCheckedChange={(checked) => setMakeRosterProjectDefault(checked === true)}
              />
              Use this roster by default for this project
            </label>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Changing posture replaces the manager runtime before its next turn and may cause one
          prompt-cache miss. It does not stop workers or alter an active graph.
        </p>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || loading} className="gap-1.5">
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function formatPosture(posture: ManagerPosture): string {
  return posture === 'hands_on' ? 'Hands-on' : 'Delegation-first'
}

function projectRosterLabel(
  rosters: Array<{ rosterId: string; name: string }>,
  rosterId: string,
): string {
  return rosters.find((roster) => roster.rosterId === rosterId)?.name
    ?? rosterId
    ?? 'Global default'
}
