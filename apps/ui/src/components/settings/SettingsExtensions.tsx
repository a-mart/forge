import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Copy,
  Check,
  FolderOpen,
  Loader2,
  Puzzle,
  RefreshCw,
} from 'lucide-react'
import type {
  SettingsExtensionsResponse,
  AgentRuntimeExtensionSnapshot,
  RuntimeExtensionMetadata,
  RuntimeExtensionLoadError,
  RuntimeExtensionSource,
} from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './settings-row'
import { fetchSettingsExtensions, toErrorMessage } from './settings-api'

/* ------------------------------------------------------------------ */
/*  Source badge colors                                                */
/* ------------------------------------------------------------------ */

const DOCS_URL = 'https://github.com/a-mart/forge/blob/main/docs/PI_EXTENSIONS.md'

const SOURCE_STYLES: Record<RuntimeExtensionSource, { label: string; className: string }> = {
  'global-worker': {
    label: 'Global Worker',
    className: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  },
  'global-manager': {
    label: 'Global Manager',
    className: 'border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400',
  },
  'profile-overlay': {
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

/* ------------------------------------------------------------------ */
/*  Copy button                                                       */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Source badge                                                      */
/* ------------------------------------------------------------------ */

function SourceBadge({ source }: { source: RuntimeExtensionSource }) {
  const style = SOURCE_STYLES[source] ?? SOURCE_STYLES.unknown
  return (
    <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-medium ${style.className}`}>
      {style.label}
    </Badge>
  )
}

/* ------------------------------------------------------------------ */
/*  Role badge                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Pill list (for tools/events)                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Extension card                                                    */
/* ------------------------------------------------------------------ */

function ExtensionItem({ ext }: { ext: RuntimeExtensionMetadata }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-foreground">{ext.displayName}</span>
        <SourceBadge source={ext.source} />
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        <code className="truncate text-[11px] text-muted-foreground font-mono">{ext.path}</code>
        <CopyButton text={ext.resolvedPath || ext.path} />
      </div>
      {(ext.tools.length > 0 || ext.events.length > 0) && (
        <div className="space-y-1">
          <PillList items={ext.tools} label="Tools" />
          <PillList items={ext.events} label="Events" />
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Load error row                                                    */
/* ------------------------------------------------------------------ */

function LoadErrorItem({ err }: { err: RuntimeExtensionLoadError }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 space-y-0.5">
        <code className="block truncate text-[11px] font-mono text-amber-600 dark:text-amber-400">
          {err.path}
        </code>
        <p className="text-xs text-muted-foreground">{err.error}</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Runtime snapshot card                                             */
/* ------------------------------------------------------------------ */

function SnapshotCard({ snapshot }: { snapshot: AgentRuntimeExtensionSnapshot }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-foreground font-mono">{snapshot.agentId}</span>
        <RoleBadge role={snapshot.role} />
        {snapshot.profileId && (
          <span className="text-[11px] text-muted-foreground">
            profile: <span className="font-mono">{snapshot.profileId}</span>
          </span>
        )}
      </div>

      {/* Extensions */}
      {snapshot.extensions.length > 0 && (
        <div className="space-y-2">
          {snapshot.extensions.map((ext) => (
            <ExtensionItem key={ext.resolvedPath || ext.path} ext={ext} />
          ))}
        </div>
      )}

      {snapshot.extensions.length === 0 && snapshot.loadErrors.length === 0 && (
        <p className="text-xs text-muted-foreground/60 italic">No extensions loaded</p>
      )}

      {/* Load errors */}
      {snapshot.loadErrors.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-amber-600 dark:text-amber-400">Load Errors</h4>
          {snapshot.loadErrors.map((err) => (
            <LoadErrorItem key={err.path} err={err} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Directory path row                                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Empty state                                                       */
/* ------------------------------------------------------------------ */

function EmptyState({ directories }: { directories?: SettingsExtensionsResponse['directories'] }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
      <Puzzle className="mb-3 size-10 text-muted-foreground/30" />
      <p className="text-sm font-medium text-muted-foreground">No active extensions</p>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground/70">
        Extensions are loaded when agent runtimes start. Drop extension files into the directories
        below and restart a session to see them here.
      </p>
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 text-xs text-primary hover:underline"
      >
        Extension documentation →
      </a>

      {directories && (
        <div className="mt-6 w-full max-w-lg space-y-1.5 rounded-md border border-border/60 bg-card/30 p-3 text-left">
          <p className="mb-2 text-[11px] font-semibold text-muted-foreground">Discovery directories</p>
          <DirectoryRow label="Global Worker" path={directories.globalWorker} />
          <DirectoryRow label="Global Manager" path={directories.globalManager} />
          <DirectoryRow label="Profile" path={directories.profileTemplate} />
          <DirectoryRow label="Project" path={directories.projectLocalRelative} />
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

interface SettingsExtensionsProps {
  wsUrl: string
}

export function SettingsExtensions({ wsUrl }: SettingsExtensionsProps) {
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

  const visibleSnapshots =
    data?.snapshots?.filter((snapshot) => snapshot.extensions.length > 0 || snapshot.loadErrors.length > 0) ?? []
  const hasSnapshots = visibleSnapshots.length > 0
  const totalExtensions = visibleSnapshots.reduce((sum, snapshot) => sum + snapshot.extensions.length, 0)
  const totalErrors = visibleSnapshots.reduce((sum, snapshot) => sum + snapshot.loadErrors.length, 0)

  return (
    <div className="flex flex-col gap-8">
      {/* Active Runtime Snapshots */}
      <SettingsSection
        label="Active Runtime Extensions"
        description={
          hasSnapshots
            ? `${totalExtensions} extension${totalExtensions !== 1 ? 's' : ''} across ${visibleSnapshots.length} runtime${visibleSnapshots.length !== 1 ? 's' : ''}${totalErrors > 0 ? ` · ${totalErrors} error${totalErrors !== 1 ? 's' : ''}` : ''}`
            : 'Extensions loaded by currently active agent runtimes'
        }
        cta={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void load()}
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

        {isLoading && !data && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && data && !hasSnapshots && <EmptyState directories={data.directories} />}

        {hasSnapshots && (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground/60">
              Reflects currently active runtimes. Runtimes without extensions or load errors are not shown.
            </p>
            {visibleSnapshots.map((snapshot) => (
              <SnapshotCard key={snapshot.agentId} snapshot={snapshot} />
            ))}
            <div className="pt-1">
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline"
              >
                Extension documentation →
              </a>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* Discovery Directories */}
      {data?.directories && hasSnapshots && (
        <SettingsSection
          label="Discovery Directories"
          description="Where Forge looks for extension files"
        >
          <div className="space-y-2 rounded-lg border border-border/60 bg-card/30 p-4">
            <DirectoryRow label="Global Worker" path={data.directories.globalWorker} />
            <DirectoryRow label="Global Manager" path={data.directories.globalManager} />
            <DirectoryRow label="Profile" path={data.directories.profileTemplate} />
            <DirectoryRow label="Project" path={data.directories.projectLocalRelative} />
          </div>
        </SettingsSection>
      )}
    </div>
  )
}
