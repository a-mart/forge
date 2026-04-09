import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import {
  AlertTriangle,
  Check,
  Copy,
  FolderOpen,
  Loader2,
  Puzzle,
  RefreshCw,
} from 'lucide-react'
import type {
  DiscoveredExtensionMetadata,
  DiscoveredExtensionSource,
  ForgeDiscoveredExtensionMetadata,
  ForgeExtensionDiagnosticError,
  ForgeRuntimeExtensionSnapshot,
  RuntimeExtensionSource,
  SettingsExtensionsResponse,
} from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './settings-row'
import { fetchSettingsExtensions, toErrorMessage } from './settings-api'

const PI_DOCS_URL = 'https://github.com/a-mart/forge/blob/main/docs/PI_EXTENSIONS.md'
const FORGE_DOCS_URL = 'https://github.com/a-mart/forge/blob/main/docs/FORGE_EXTENSIONS.md'

const PI_DISCOVERY_SOURCE_ORDER: DiscoveredExtensionSource[] = [
  'global-worker',
  'global-manager',
  'profile',
  'project-local',
]

type SourceBadgeValue = RuntimeExtensionSource | DiscoveredExtensionSource

const SOURCE_STYLES: Record<SourceBadgeValue, { label: string; className: string }> = {
  'global-worker': {
    label: 'Global Worker',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  },
  'global-manager': {
    label: 'Global Manager',
    className: 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400',
  },
  profile: {
    label: 'Profile',
    className: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
  },
  'project-local': {
    label: 'Project',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  package: {
    label: 'Package',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  unknown: {
    label: 'Unknown',
    className: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  },
}

const FORGE_SCOPE_STYLES: Record<ForgeDiscoveredExtensionMetadata['scope'], { label: string; className: string }> = {
  global: {
    label: 'Global',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  },
  profile: {
    label: 'Profile',
    className: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
  },
  'project-local': {
    label: 'Project',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
}

interface RuntimeOverlayBinding {
  agentId: string
  role: 'manager' | 'worker'
  profileId?: string
  loadedAt: string
  events: string[]
  tools: string[]
}

interface RuntimeOverlayError {
  agentId: string
  role: 'manager' | 'worker'
  path: string
  error: string
}

interface RuntimeOverlay {
  bindings: RuntimeOverlayBinding[]
  errors: RuntimeOverlayError[]
}

interface SettingsExtensionsProps {
  wsUrl: string
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API may fail in some environments
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
      title="Copy path"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function SourceBadge({ source }: { source: SourceBadgeValue }) {
  const style = SOURCE_STYLES[source] ?? SOURCE_STYLES.unknown
  return (
    <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-medium ${style.className}`}>
      {style.label}
    </Badge>
  )
}

function ForgeScopeBadge({ scope }: { scope: ForgeDiscoveredExtensionMetadata['scope'] }) {
  const style = FORGE_SCOPE_STYLES[scope]
  return (
    <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-medium ${style.className}`}>
      {style.label}
    </Badge>
  )
}

function RoleBadge({ role }: { role: 'manager' | 'worker' }) {
  const isManager = role === 'manager'
  return (
    <Badge
      variant="outline"
      className={`px-1.5 py-0 text-[10px] font-medium ${
        isManager
          ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
          : 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'
      }`}
    >
      {role}
    </Badge>
  )
}

function PillList({ items, label }: { items: string[]; label: string }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] font-medium text-muted-foreground/70">{label}:</span>
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex rounded-md bg-muted/80 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
        >
          {item}
        </span>
      ))}
    </div>
  )
}

function DirectoryRow({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground/50" />
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <code className="truncate text-[11px] font-mono text-muted-foreground/80">{path}</code>
      <CopyButton text={path} />
    </div>
  )
}

function ForgeErrorItem({ error }: { error: ForgeExtensionDiagnosticError }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">{error.phase}</span>
          {error.agentId && <span className="font-mono">{error.agentId}</span>}
          {error.runtimeType && (
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium uppercase">
              {error.runtimeType}
            </Badge>
          )}
          <span>{new Date(error.timestamp).toLocaleString()}</span>
        </div>
        <p className="text-xs text-muted-foreground">{error.message}</p>
        {(error.path || error.hook) && (
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground/80">
            {error.hook && <span>hook: <code className="font-mono">{error.hook}</code></span>}
            {error.path && <span className="min-w-0 truncate">path: <code className="font-mono">{error.path}</code></span>}
          </div>
        )}
      </div>
    </div>
  )
}

function PiRuntimeErrorItem({ error }: { error: RuntimeOverlayError }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono text-amber-600 dark:text-amber-400">{error.agentId}</span>
          <RoleBadge role={error.role} />
        </div>
        <p className="text-xs text-muted-foreground">{error.error}</p>
      </div>
    </div>
  )
}

function ForgeExtensionCard({ extension }: { extension: ForgeDiscoveredExtensionMetadata }) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{extension.displayName}</span>
        <ForgeScopeBadge scope={extension.scope} />
        {extension.name && (
          <span className="text-xs text-muted-foreground">
            name: <span className="font-medium text-foreground">{extension.name}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 min-w-0">
        <code className="truncate text-[11px] font-mono text-muted-foreground">{extension.path}</code>
        <CopyButton text={extension.path} />
      </div>

      {(extension.profileId || extension.cwd) && (
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          {extension.profileId && <span>profile: <code className="font-mono">{extension.profileId}</code></span>}
          {extension.cwd && <span>cwd: <code className="font-mono">{extension.cwd}</code></span>}
        </div>
      )}

      {extension.description && <p className="text-xs text-muted-foreground">{extension.description}</p>}

      {extension.loadError ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {extension.loadError}
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground/70">Metadata loaded successfully</p>
      )}
    </div>
  )
}

function ForgeRuntimeSnapshotCard({ snapshot }: { snapshot: ForgeRuntimeExtensionSnapshot }) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{snapshot.agentId}</span>
        <RoleBadge role={snapshot.role} />
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium uppercase">
          {snapshot.runtimeType}
        </Badge>
        {snapshot.profileId && <span className="text-[11px] text-muted-foreground">profile: {snapshot.profileId}</span>}
      </div>

      <p className="text-[11px] text-muted-foreground">Loaded {new Date(snapshot.loadedAt).toLocaleString()}</p>

      <div className="space-y-2">
        {snapshot.extensions.map((extension) => (
          <div key={`${snapshot.agentId}:${extension.path}`} className="rounded-md border border-border/50 bg-background/30 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-foreground">{extension.name ?? extension.displayName}</span>
              <ForgeScopeBadge scope={extension.scope} />
            </div>
            <div className="mt-1 flex items-center gap-1.5 min-w-0">
              <code className="truncate text-[11px] font-mono text-muted-foreground">{extension.path}</code>
              <CopyButton text={extension.path} />
            </div>
            {extension.description && <p className="mt-2 text-xs text-muted-foreground">{extension.description}</p>}
            <div className="mt-2">
              <PillList items={extension.hooks} label="Hooks" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PiDiscoveredExtensionCard({
  extension,
  overlay,
}: {
  extension: DiscoveredExtensionMetadata
  overlay?: RuntimeOverlay
}) {
  const boundTools = useMemo(() => {
    if (!overlay) return []
    return dedupeAndSort(overlay.bindings.flatMap((binding) => binding.tools))
  }, [overlay])

  const boundEvents = useMemo(() => {
    if (!overlay) return []
    return dedupeAndSort(overlay.bindings.flatMap((binding) => binding.events))
  }, [overlay])

  const activeBindings = overlay?.bindings ?? []
  const runtimeErrors = overlay?.errors ?? []

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{extension.displayName}</span>
        <SourceBadge source={extension.source} />
        {extension.profileId && (
          <span className="text-[11px] text-muted-foreground">
            profile: <span className="font-mono">{extension.profileId}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 min-w-0">
        <code className="truncate text-[11px] font-mono text-muted-foreground">{extension.path}</code>
        <CopyButton text={extension.path} />
      </div>

      {extension.cwd && (
        <div className="text-[11px] text-muted-foreground">
          cwd: <code className="font-mono">{extension.cwd}</code>
        </div>
      )}

      {activeBindings.length === 0 && runtimeErrors.length === 0 && (
        <p className="text-xs italic text-muted-foreground/70">Not loaded in active runtimes</p>
      )}

      {activeBindings.length > 0 && (
        <div className="space-y-2 rounded-md border border-border/50 bg-background/30 p-2.5">
          <p className="text-xs text-muted-foreground">
            Loaded by {activeBindings.length} runtime{activeBindings.length !== 1 ? 's' : ''}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {activeBindings.map((binding) => (
              <span
                key={`${binding.agentId}:${binding.loadedAt}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-card/50 px-1.5 py-0.5"
              >
                <span className="text-[10px] font-mono text-foreground">{binding.agentId}</span>
                <RoleBadge role={binding.role} />
              </span>
            ))}
          </div>
          {(boundTools.length > 0 || boundEvents.length > 0) && (
            <div className="space-y-1">
              <PillList items={boundTools} label="Tools" />
              <PillList items={boundEvents} label="Events" />
            </div>
          )}
        </div>
      )}

      {runtimeErrors.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-amber-600 dark:text-amber-400">Runtime Load Errors</h4>
          {runtimeErrors.map((error) => (
            <PiRuntimeErrorItem key={`${error.agentId}:${error.path}:${error.error}`} error={error} />
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({
  title,
  description,
  docsUrl,
  children,
}: {
  title: string
  description: string
  docsUrl: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
      <Puzzle className="mb-3 size-10 text-muted-foreground/30" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground/70">{description}</p>
      <a href={docsUrl} target="_blank" rel="noreferrer" className="mt-3 text-xs text-primary hover:underline">
        Extension documentation →
      </a>
      {children}
    </div>
  )
}

function ForgeExtensionsSection({
  forge,
  isLoading,
  error,
  onRefresh,
}: {
  forge?: SettingsExtensionsResponse['forge']
  isLoading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const hasPayload = Boolean(forge)
  const discovered = useMemo(() => forge?.discovered ?? [], [forge?.discovered])
  const snapshots = forge?.snapshots ?? []
  const recentErrors = forge?.recentErrors ?? []
  const groupedDiscovered = useMemo(() => {
    const grouped = new Map<ForgeDiscoveredExtensionMetadata['scope'], ForgeDiscoveredExtensionMetadata[]>()
    grouped.set('global', [])
    grouped.set('profile', [])
    grouped.set('project-local', [])
    for (const extension of discovered) {
      grouped.get(extension.scope)?.push(extension)
    }
    return grouped
  }, [discovered])

  return (
    <SettingsSection
      label="Forge Extensions"
      description={
        discovered.length > 0
          ? `${discovered.length} extension${discovered.length !== 1 ? 's' : ''} discovered${snapshots.length > 0 ? ` · ${snapshots.length} active runtime snapshot${snapshots.length !== 1 ? 's' : ''}` : ''}${recentErrors.length > 0 ? ` · ${recentErrors.length} recent error${recentErrors.length !== 1 ? 's' : ''}` : ''}`
          : 'Forge-native hook extensions discovered from disk'
      }
      cta={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          className="gap-1.5 text-muted-foreground"
        >
          <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      }
    >
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {isLoading && !forge && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && hasPayload && discovered.length === 0 && (
        <EmptyState
          title="No Forge extensions found on disk"
          description="Drop .ts or .js files into the directories below. Forge also supports folders with index.ts or index.js entrypoints."
          docsUrl={FORGE_DOCS_URL}
        >
          {forge?.directories && (
            <div className="mt-6 w-full max-w-lg space-y-1.5 rounded-md border border-border/60 bg-card/30 p-3 text-left">
              <p className="mb-2 text-[11px] font-semibold text-muted-foreground">Discovery directories</p>
              <DirectoryRow label="Global" path={forge.directories.global} />
              <DirectoryRow label="Profile" path={forge.directories.profileTemplate} />
              <DirectoryRow label="Project" path={forge.directories.projectLocalRelative} />
            </div>
          )}
        </EmptyState>
      )}

      {discovered.length > 0 && (
        <div className="space-y-5">
          {(['global', 'profile', 'project-local'] as const).map((scope) => {
            const entries = groupedDiscovered.get(scope) ?? []
            if (entries.length === 0) {
              return null
            }

            return (
              <div key={scope} className="space-y-2">
                <div className="flex items-center gap-2">
                  <ForgeScopeBadge scope={scope} />
                  <p className="text-xs text-muted-foreground">
                    {entries.length} extension{entries.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <div className="space-y-2">
                  {entries.map((extension) => (
                    <ForgeExtensionCard
                      key={`${extension.scope}:${extension.path}:${extension.profileId ?? ''}:${extension.cwd ?? ''}`}
                      extension={extension}
                    />
                  ))}
                </div>
              </div>
            )
          })}

          <div className="pt-1">
            <a href={FORGE_DOCS_URL} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
              Forge extension documentation →
            </a>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Active runtime snapshots</h3>
          {snapshots.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
              No active Forge runtime bindings yet.
            </p>
          ) : (
            <div className="space-y-2">
              {snapshots.map((snapshot) => (
                <ForgeRuntimeSnapshotCard key={`${snapshot.agentId}:${snapshot.loadedAt}`} snapshot={snapshot} />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Recent errors</h3>
          {recentErrors.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
              No recent Forge extension errors.
            </p>
          ) : (
            <div className="space-y-2">
              {recentErrors.map((recentError, index) => (
                <ForgeErrorItem key={`${recentError.timestamp}:${recentError.path ?? ''}:${index}`} error={recentError} />
              ))}
            </div>
          )}
        </div>
      </div>

      {forge?.directories && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-card/30 p-4">
          <p className="text-[11px] font-semibold text-muted-foreground">Discovery directories</p>
          <DirectoryRow label="Global" path={forge.directories.global} />
          <DirectoryRow label="Profile" path={forge.directories.profileTemplate} />
          <DirectoryRow label="Project" path={forge.directories.projectLocalRelative} />
        </div>
      )}
    </SettingsSection>
  )
}

function PiExtensionsSection({ data }: { data: SettingsExtensionsResponse | null }) {
  const hasPayload = data !== null
  const runtimeOverlayByPath = useMemo(() => {
    return buildRuntimeOverlayMap(data?.snapshots ?? [])
  }, [data?.snapshots])

  const discoveredExtensions = useMemo(() => data?.discovered ?? [], [data?.discovered])
  const groupedDiscoveredExtensions = useMemo(() => {
    const grouped = new Map<DiscoveredExtensionSource, DiscoveredExtensionMetadata[]>()
    for (const source of PI_DISCOVERY_SOURCE_ORDER) {
      grouped.set(source, [])
    }

    for (const extension of discoveredExtensions) {
      grouped.get(extension.source)?.push(extension)
    }

    return grouped
  }, [discoveredExtensions])

  const extensionsWithBindings = discoveredExtensions.filter((extension) => {
    const overlay = runtimeOverlayByPath.get(normalizePathKey(extension.path))
    return Boolean(overlay && overlay.bindings.length > 0)
  }).length

  const extensionsWithErrors = discoveredExtensions.filter((extension) => {
    const overlay = runtimeOverlayByPath.get(normalizePathKey(extension.path))
    return Boolean(overlay && overlay.errors.length > 0)
  }).length

  return (
    <SettingsSection
      label="Pi Extensions & Packages"
      description={
        discoveredExtensions.length > 0
          ? `${discoveredExtensions.length} extension${discoveredExtensions.length !== 1 ? 's' : ''} on disk${extensionsWithBindings > 0 ? ` · ${extensionsWithBindings} loaded in active runtimes` : ''}${extensionsWithErrors > 0 ? ` · ${extensionsWithErrors} with runtime errors` : ''}`
          : 'Pi extensions discovered from disk'
      }
    >
      {hasPayload && discoveredExtensions.length === 0 ? (
        <EmptyState
          title="No Pi extensions found on disk"
          description="Drop Pi extension files into the directories below. Pi supports single .ts/.js files and folders with index.ts or index.js."
          docsUrl={PI_DOCS_URL}
        >
          {data?.directories && (
            <div className="mt-6 w-full max-w-lg space-y-1.5 rounded-md border border-border/60 bg-card/30 p-3 text-left">
              <p className="mb-2 text-[11px] font-semibold text-muted-foreground">Discovery directories</p>
              <DirectoryRow label="Global Worker" path={data.directories.globalWorker} />
              <DirectoryRow label="Global Manager" path={data.directories.globalManager} />
              <DirectoryRow label="Profile" path={data.directories.profileTemplate} />
              <DirectoryRow label="Project" path={data.directories.projectLocalRelative} />
            </div>
          )}
        </EmptyState>
      ) : hasPayload ? (
        <div className="space-y-4">
          <p className="text-[11px] text-muted-foreground/70">
            Runtime details are overlaid when matching active sessions have loaded an extension.
          </p>

          {PI_DISCOVERY_SOURCE_ORDER.map((source) => {
            const entries = groupedDiscoveredExtensions.get(source) ?? []
            if (entries.length === 0) {
              return null
            }

            return (
              <div key={source} className="space-y-2">
                <div className="flex items-center gap-2">
                  <SourceBadge source={source} />
                  <p className="text-xs text-muted-foreground">
                    {entries.length} extension{entries.length !== 1 ? 's' : ''}
                  </p>
                </div>

                <div className="space-y-2">
                  {entries.map((extension) => (
                    <PiDiscoveredExtensionCard
                      key={`${source}:${extension.path}:${extension.profileId ?? ''}:${extension.cwd ?? ''}`}
                      extension={extension}
                      overlay={runtimeOverlayByPath.get(normalizePathKey(extension.path))}
                    />
                  ))}
                </div>
              </div>
            )
          })}

          <div className="pt-1">
            <a href={PI_DOCS_URL} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
              Pi extension documentation →
            </a>
          </div>
        </div>
      ) : null}

      {data?.directories && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-card/30 p-4">
          <p className="text-[11px] font-semibold text-muted-foreground">Discovery directories</p>
          <DirectoryRow label="Global Worker" path={data.directories.globalWorker} />
          <DirectoryRow label="Global Manager" path={data.directories.globalManager} />
          <DirectoryRow label="Profile" path={data.directories.profileTemplate} />
          <DirectoryRow label="Project" path={data.directories.projectLocalRelative} />
        </div>
      )}
    </SettingsSection>
  )
}

export function SettingsExtensions({ wsUrl }: SettingsExtensionsProps) {
  useHelpContext('settings.extensions')

  const [data, setData] = useState<SettingsExtensionsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await fetchSettingsExtensions(wsUrl)
      setData(result)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }, [wsUrl])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex flex-col gap-8">
      <ForgeExtensionsSection forge={data?.forge} isLoading={isLoading} error={error} onRefresh={() => void load()} />
      <PiExtensionsSection data={data} />
    </div>
  )
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

function dedupeAndSort(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right))
}

function buildRuntimeOverlayMap(
  snapshots: SettingsExtensionsResponse['snapshots']
): Map<string, RuntimeOverlay> {
  const map = new Map<string, RuntimeOverlay>()

  for (const snapshot of snapshots) {
    for (const extension of snapshot.extensions) {
      const key = normalizePathKey(extension.resolvedPath || extension.path)
      if (!key) {
        continue
      }

      const overlay = getOrCreateOverlay(map, key)
      overlay.bindings.push({
        agentId: snapshot.agentId,
        role: snapshot.role,
        profileId: snapshot.profileId,
        loadedAt: snapshot.loadedAt,
        events: extension.events,
        tools: extension.tools,
      })
    }

    for (const loadError of snapshot.loadErrors) {
      const key = normalizePathKey(loadError.path)
      if (!key) {
        continue
      }

      const overlay = getOrCreateOverlay(map, key)
      overlay.errors.push({
        agentId: snapshot.agentId,
        role: snapshot.role,
        path: loadError.path,
        error: loadError.error,
      })
    }
  }

  for (const overlay of map.values()) {
    overlay.bindings = dedupeBindings(overlay.bindings)
    overlay.errors = dedupeErrors(overlay.errors)
  }

  return map
}

function getOrCreateOverlay(map: Map<string, RuntimeOverlay>, key: string): RuntimeOverlay {
  const existing = map.get(key)
  if (existing) {
    return existing
  }

  const created: RuntimeOverlay = {
    bindings: [],
    errors: [],
  }
  map.set(key, created)
  return created
}

function dedupeBindings(bindings: RuntimeOverlayBinding[]): RuntimeOverlayBinding[] {
  const unique = new Map<string, RuntimeOverlayBinding>()
  for (const binding of bindings) {
    const key = `${binding.agentId}::${binding.loadedAt}::${binding.role}`
    if (!unique.has(key)) {
      unique.set(key, binding)
    }
  }
  return Array.from(unique.values())
}

function dedupeErrors(errors: RuntimeOverlayError[]): RuntimeOverlayError[] {
  const unique = new Map<string, RuntimeOverlayError>()
  for (const error of errors) {
    const key = `${error.agentId}::${error.path}::${error.error}`
    if (!unique.has(key)) {
      unique.set(key, error)
    }
  }
  return Array.from(unique.values())
}
