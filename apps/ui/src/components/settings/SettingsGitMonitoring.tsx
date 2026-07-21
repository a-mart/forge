import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ManagerProfile, RemoteUpdateAwarenessProjectOverride, RemoteUpdateAwarenessSettingsSnapshot } from '@forge/protocol'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  fetchRemoteUpdateAwarenessSettings,
  updateRemoteUpdateAwarenessProjectOverride,
  updateRemoteUpdateAwarenessSettings,
} from './remote-update-awareness-api'

export function SettingsGitMonitoring({ wsUrl, profiles }: { wsUrl: string; profiles: ManagerProfile[] }) {
  const [snapshot, setSnapshot] = useState<RemoteUpdateAwarenessSettingsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      setSnapshot(await fetchRemoteUpdateAwarenessSettings(wsUrl))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Git monitoring is unavailable.')
    }
  }, [wsUrl])

  useEffect(() => { void load() }, [load])

  const names = useMemo(() => new Map(profiles.map((profile) => [profile.profileId, profile.displayName])), [profiles])
  const updateGlobal = async (globalEnabled: boolean) => {
    setUpdating(true)
    try {
      setError(null)
      setSnapshot(await updateRemoteUpdateAwarenessSettings(wsUrl, globalEnabled))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update Git monitoring.')
    } finally {
      setUpdating(false)
    }
  }
  const updateProject = async (projectId: string, override: RemoteUpdateAwarenessProjectOverride) => {
    setUpdating(true)
    try {
      setError(null)
      const response = await updateRemoteUpdateAwarenessProjectOverride(wsUrl, projectId, override)
      setSnapshot((current) => current && {
        ...current,
        projects: current.projects.map((project) => project.projectId === projectId ? response.project : project),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update this project.')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="space-y-6" data-testid="git-monitoring-settings">
      <div>
        <h2 className="text-lg font-semibold">Git monitoring</h2>
        <p className="mt-1 text-sm text-muted-foreground">Local awareness for remote default-branch changes.</p>
      </div>
      <SettingsSection label="Remote update checks" description="Forge checks only while this Builder is open.">
        <SettingsWithCTA
          label="Check remote updates for local Git projects"
          description="When enabled, Forge may fetch each eligible project’s selected remote default branch while it is open. New installations start off."
        >
          <Switch
            checked={snapshot?.settings.globalEnabled ?? false}
            disabled={!snapshot || updating}
            onCheckedChange={updateGlobal}
            aria-label="Check remote updates for local Git projects"
          />
        </SettingsWithCTA>
      </SettingsSection>
      <SettingsSection
        label="Projects"
        description="Only current local Git projects appear here. Archived and non-Git projects are excluded. “On” still requires the global switch."
      >
        {!snapshot && !error ? <p className="text-sm text-muted-foreground">Loading local Git projects…</p> : null}
        {snapshot?.projects.length === 0 ? <p className="text-sm text-muted-foreground">No eligible local Git projects.</p> : null}
        {snapshot?.projects.map((project) => (
          <div key={project.projectId} className="flex flex-col justify-between gap-2 rounded-md border border-border/60 p-3 sm:flex-row sm:items-center">
            <div>
              <Label className="text-sm font-medium">{names.get(project.projectId) ?? project.projectId}</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {project.effectiveEnabled ? 'Checking while Forge is open.' : snapshot.settings.globalEnabled ? 'Excluded by this project setting.' : 'Global Git monitoring is off.'}
              </p>
            </div>
            <Select value={project.override} disabled={updating} onValueChange={(value) => void updateProject(project.projectId, value as RemoteUpdateAwarenessProjectOverride)}>
              <SelectTrigger className="w-full sm:w-32" aria-label={`Git monitoring for ${names.get(project.projectId) ?? project.projectId}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Inherit</SelectItem>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
      </SettingsSection>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
