import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentDescriptor,
  ProjectResourcesSnapshotResponse,
  RepoProjectAgentInventorySection,
} from '@forge/protocol'
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import type { SettingsApiClient } from './settings-api-client'
import {
  fetchProjectResourcesSnapshot,
  updateProjectResourcesOverride,
  updateProjectResourcesTrust,
} from './project-resources-api'
import {
  ProjectAgentDefinitionRow,
  useRepoProjectAgentActivation,
} from './repo-project-agent-ui'

interface SettingsProjectResourcesProps {
  managers: AgentDescriptor[]
  previewSession?: { agentId: string; profileId: string } | null
  apiClient: SettingsApiClient
}

export function SettingsProjectResources({ managers, previewSession, apiClient }: SettingsProjectResourcesProps) {
  const context = useMemo(() => {
    if (previewSession) return { profileId: previewSession.profileId, sessionAgentId: previewSession.agentId }
    const manager = managers.find((entry) => entry.role === 'manager')
    return manager ? { profileId: manager.profileId ?? manager.agentId, sessionAgentId: manager.agentId } : null
  }, [managers, previewSession])
  const [snapshot, setSnapshot] = useState<ProjectResourcesSnapshotResponse | null>(null)
  const [overridePath, setOverridePath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      const next = await fetchProjectResourcesSnapshot(apiClient, context)
      setSnapshot(next)
      setOverridePath(next.override?.path ?? next.effectiveForgeDir ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repository resources')
    } finally {
      setLoading(false)
    }
  }, [apiClient, context])

  useEffect(() => { void load() }, [load])

  const mutateTrust = async (action: 'trust' | 'block' | 'reset') => {
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      const result = await updateProjectResourcesTrust(apiClient, { ...context, action })
      setSnapshot(result.snapshot)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update trust')
    } finally {
      setLoading(false)
    }
  }

  const saveOverride = async (forgeDir: string | null) => {
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      const result = await updateProjectResourcesOverride(apiClient, { ...context, forgeDir })
      setSnapshot(result.snapshot)
      setOverridePath(result.snapshot.override?.path ?? result.snapshot.effectiveForgeDir ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update override')
    } finally {
      setLoading(false)
    }
  }

  if (!context) {
    return <Card><CardHeader><CardTitle>Repository resources</CardTitle><CardDescription>No manager session is available.</CardDescription></CardHeader></Card>
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Repository resources</h2>
        <p className="text-sm text-muted-foreground">Discover repo-root <code>.forge</code> resources for this session. Executable resources remain inactive until trusted.</p>
      </div>
      {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">Repository {snapshot && <TrustBadge state={snapshot.trust.state} />}</CardTitle>
            <CardDescription>{snapshot?.cwdRealpath ?? 'Loading repository context...'}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
        </CardHeader>
        {snapshot && (
          <CardContent className="space-y-3 text-sm">
            {snapshot.warning && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div><div className="font-medium">Repository unavailable</div><div className="text-xs">{snapshot.warning}</div></div>
              </div>
            )}
            <KeyValue label="Detected Git root" value={snapshot.detectedGitRoot ?? 'None'} />
            <KeyValue label="Effective .forge" value={snapshot.effectiveForgeDirRealpath ?? 'None'} />
            <KeyValue label="Source" value={snapshot.source} />
            <KeyValue label="Signature" value={snapshot.signature.slice(0, 12)} />
            {snapshot.override && !snapshot.override.valid && (
              <div className="flex items-center gap-2 text-amber-600"><AlertTriangle className="h-4 w-4" />Override invalid: {snapshot.override.error}</div>
            )}
            <Separator />
            <div className="space-y-2">
              <div className="font-medium">Override .forge directory</div>
              <div className="flex gap-2">
                <Input value={overridePath} onChange={(event) => setOverridePath(event.target.value)} placeholder="/path/to/.forge" />
                <Button variant="outline" onClick={() => void saveOverride(overridePath.trim())} disabled={loading || !overridePath.trim()}>Save</Button>
                <Button variant="ghost" onClick={() => void saveOverride(null)} disabled={loading}>Clear</Button>
              </div>
              <p className="text-xs text-muted-foreground">Overrides are scoped to this profile and repository. The selected directory must be named <code>.forge</code>.</p>
            </div>
          </CardContent>
        )}
      </Card>
      {snapshot && (
        <>
          <Card>
            <CardHeader><CardTitle>Inventory</CardTitle><CardDescription>Passive resources are visible even when executables are blocked.</CardDescription></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <InventoryTile title="Repository skills" section={snapshot.resources.skills} />
              <InventoryTile title="Specialists" section={snapshot.resources.specialists} />
              <InventoryTile title="Reference docs" section={snapshot.resources.reference} />
              <InventoryTile title="Forge extensions" section={snapshot.resources.forgeExtensions} executable />
              <InventoryTile title="Pi extensions" section={snapshot.resources.piExtensions} executable />
              <InventoryTile title="Pi settings" section={snapshot.resources.piSettings} executable />
            </CardContent>
          </Card>
          {snapshot.resources.projectAgents ? (
            <ProjectAgentInventory
              section={snapshot.resources.projectAgents}
              context={context}
              apiClient={apiClient}
              onRefresh={load}
            />
          ) : null}
          <Card>
            <CardHeader><CardTitle>Executable trust</CardTitle><CardDescription>Trust is path-only for the selected .forge directory. Changing trust or the override restarts affected runtimes so executable resources cannot stay loaded under stale policy.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void mutateTrust('trust')} disabled={loading || !snapshot.trust.key}>Trust repo path</Button>
                <Button size="sm" variant="outline" onClick={() => void mutateTrust('block')} disabled={loading || !snapshot.trust.key}>Block repo path</Button>
                <Button size="sm" variant="ghost" onClick={() => void mutateTrust('reset')} disabled={loading || !snapshot.trust.key}>Reset</Button>
              </div>
              <div className="space-y-2 text-sm">
                {snapshot.executableSurfaces.map((surface) => (
                  <div key={`${surface.kind}:${surface.path}`} className="rounded-md border p-2">
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">{formatSurfaceKind(surface.kind)}</span><Badge variant={surface.exists ? 'default' : 'secondary'}>{surface.exists ? 'found' : 'missing'}</Badge></div>
                    <div className="mt-1 break-all text-xs text-muted-foreground">{surface.path}</div>
                    {surface.compatibilityPolicy && <div className="mt-1 text-xs text-amber-600">Compatibility surface. It is active only when it is inside the selected trusted .forge directory; use repo-root .forge paths for new resources.</div>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function TrustBadge({ state }: { state: ProjectResourcesSnapshotResponse['trust']['state'] }) {
  if (state === 'trusted') return <Badge className="gap-1"><CheckCircle2 className="h-3 w-3" />Trusted</Badge>
  if (state === 'blocked') return <Badge variant="destructive" className="gap-1"><ShieldAlert className="h-3 w-3" />Blocked</Badge>
  return <Badge variant="secondary">{state === 'not_applicable' ? 'No .forge' : 'Untrusted'}</Badge>
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div><span className="text-muted-foreground">{label}: </span><span className="break-all font-mono text-xs">{value}</span></div>
}

function formatSurfaceKind(kind: ProjectResourcesSnapshotResponse['executableSurfaces'][number]['kind']) {
  switch (kind) {
    case 'repo-forge-extensions': return 'Repository Forge extensions'
    case 'repo-pi-extensions': return 'Repository Pi extensions'
    case 'repo-pi-settings': return 'Repository Pi settings packages'
    case 'exact-cwd-forge-extension': return 'Legacy exact-CWD Forge extensions'
    case 'exact-cwd-pi-extension': return 'Legacy exact-CWD Pi extensions'
    case 'exact-cwd-pi-settings': return 'Legacy exact-CWD Pi settings packages'
  }
}

function InventoryTile({ title, section, executable }: { title: string; section: ProjectResourcesSnapshotResponse['resources']['skills']; executable?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2"><div className="font-medium">{title}</div>{executable && <Badge variant="outline">executable</Badge>}</div>
      <div className="mt-1 text-2xl font-semibold">{section.count}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{section.path ?? 'No path'}</div>
      {section.items.length > 0 && <div className="mt-2 text-xs text-muted-foreground">{section.items.slice(0, 3).map((item) => item.path).join(', ')}{section.count > 3 || section.truncated ? '…' : ''}</div>}
      {section.truncated && <div className="mt-1 text-xs text-muted-foreground">Showing first {section.items.length} items.</div>}
    </div>
  )
}

// ── Project Agent Inventory ──

function ProjectAgentInventory({
  section,
  context,
  apiClient,
  onRefresh,
}: {
  section: RepoProjectAgentInventorySection
  context: { profileId: string; sessionAgentId: string }
  apiClient: SettingsApiClient
  onRefresh: () => void
}) {
  const {
    activatingId,
    activateError,
    handleActivate,
  } = useRepoProjectAgentActivation({
    apiClient,
    context,
    onActivated: () => { onRefresh() },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          Project Agent Definitions
        </CardTitle>
        <CardDescription>
          Agent definitions from <code>.forge/project-agents/</code>. Activate to create a live project agent session from a repo definition.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {section.problems?.map((problem, index) => (
          <div key={index} className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{problem.message}</span>
          </div>
        ))}
        {activateError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            {activateError}
          </div>
        ) : null}
        {!section.exists ? (
          <p className="text-sm text-muted-foreground">
            No <code>.forge/project-agents/</code> directory found.
          </p>
        ) : section.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            No project agent definitions found. Add a directory under <code>.forge/project-agents/</code> with a <code>config.json</code> and <code>prompt.md</code>.
          </p>
        ) : (
          <div className="space-y-2">
            {section.items.map((item) => (
              <ProjectAgentDefinitionRow
                key={item.definitionId}
                item={item}
                activating={activatingId === item.definitionId}
                onActivate={item.status === 'valid' && !item.activatedAgentId
                  ? () => { void handleActivate(item) }
                  : undefined}
              />
            ))}
            {section.truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing first {section.items.length} of {section.count} definitions.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
