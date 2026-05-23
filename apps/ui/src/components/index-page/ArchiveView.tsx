import { Archive, RotateCcw } from 'lucide-react'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { getArchivedProfileRows, getDirectlyArchivedSessionRows, getProfileRowLastUserMessageAt } from '@/lib/agent-hierarchy'

interface ArchiveViewProps {
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  onBack: () => void
  onRestoreProfile: (profileId: string, open?: boolean) => void
  onRestoreSession: (agentId: string, open?: boolean) => void
}

function sessionLabel(agent: AgentDescriptor, isDefault = false): string {
  return agent.sessionLabel || (isDefault ? 'Main' : agent.displayName || agent.agentId)
}

function profileLabel(profile: ManagerProfile): string {
  return profile.displayName || profile.profileId
}

function formatLastUsed(timestamp: string | null): string {
  if (!timestamp) return 'Last used unknown'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Last used unknown'
  return `Last used ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`
}

export function ArchiveView({
  agents,
  profiles,
  onBack,
  onRestoreProfile,
  onRestoreSession,
}: ArchiveViewProps) {
  const archivedProfiles = getArchivedProfileRows(agents, profiles)
  const archivedSessions = getDirectlyArchivedSessionRows(agents, profiles)
  const hasArchivedItems = archivedProfiles.length > 0 || archivedSessions.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground" data-testid="archive-view">
      <header className="flex shrink-0 items-center justify-between border-b px-5 py-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Archive className="size-5" aria-hidden="true" />
            Archive
          </h1>
          <p className="text-sm text-muted-foreground">Restore archived projects and sessions.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>Back</Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {!hasArchivedItems ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            Nothing is archived.
          </div>
        ) : null}

        {archivedProfiles.length > 0 ? (
          <section className="space-y-3" aria-labelledby="archived-projects-heading">
            <h2 id="archived-projects-heading" className="text-sm font-semibold text-muted-foreground">Archived projects</h2>
            <div className="space-y-2">
              {archivedProfiles.map((row) => {
                const lastUsed = getProfileRowLastUserMessageAt(row)
                return (
                  <div key={row.profile.profileId} className="rounded-lg border bg-card p-4" data-testid="archived-project-row">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-medium">{profileLabel(row.profile)}</h3>
                        <p className="text-xs text-muted-foreground">
                          {row.sessions.length} session{row.sessions.length === 1 ? '' : 's'} archived with this project
                        </p>
                        <p className="text-xs text-muted-foreground" data-testid="archived-project-last-used">
                          {formatLastUsed(lastUsed)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button type="button" size="sm" onClick={() => onRestoreProfile(row.profile.profileId, true)}>
                          <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                          Restore
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        {archivedSessions.length > 0 ? (
          <section className="mt-6 space-y-3" aria-labelledby="archived-sessions-heading">
            <h2 id="archived-sessions-heading" className="text-sm font-semibold text-muted-foreground">Archived sessions</h2>
            <div className="space-y-2">
              {archivedSessions.map((row) => {
                const parentProfile = profiles.find((p) => p.profileId === row.sessionAgent.profileId)
                return (
                  <div key={row.sessionAgent.agentId} className="rounded-lg border bg-card p-4" data-testid="archived-session-row">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-medium">{sessionLabel(row.sessionAgent, row.isDefault)}</h3>
                        {parentProfile ? (
                          <p className="text-xs text-muted-foreground" data-testid="archived-session-project">{profileLabel(parentProfile)}</p>
                        ) : (
                          <p className="text-xs text-muted-foreground">{row.sessionAgent.agentId}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button type="button" size="sm" onClick={() => onRestoreSession(row.sessionAgent.agentId, true)}>
                          <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                          Restore
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
