import { Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingsSection } from './settings-row'
import { useHistoryIndex } from './use-history-index'

export function SettingsHistory({ wsUrl }: { wsUrl: string }) {
  return <HistoryPanel key={wsUrl} wsUrl={wsUrl} />
}

const ACTIVITY = { starting: 'Starting', indexing: 'Indexing', idle: 'Indexing complete', paused: 'Paused', unavailable: 'Unavailable' }

function HistoryPanel({ wsUrl }: { wsUrl: string }) {
  const { status, error, updating, refresh, togglePaused } = useHistoryIndex(wsUrl)
  const stats = status?.statistics
  const hasSearchLimitations = !!stats && (stats.unreadableSources > 0 || stats.omittedSources > 0)
  return (
    <div className="space-y-6" data-testid="history-settings">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">History</h2>
          <p className="mt-1 text-sm text-muted-foreground">Local history recall across eligible projects, sessions, and workers.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={updating}><RefreshCw className="mr-2 size-4" />Refresh</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error} Displayed information may be out of date.</p> : null}
      {!status ? <p role="status" className="text-sm text-muted-foreground">{error ? 'History status could not be loaded.' : 'Loading history index…'}</p> : <>
        <SettingsSection label="Indexing" description="This preference applies to this Builder and persists after restart.">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-2">
              <Badge variant="outline">{ACTIVITY[status.activity]}</Badge>
              <p className="max-w-xl text-sm text-muted-foreground">{status.paused
                ? 'Indexing is paused. Saved conversations and cached search results remain available; newer content may be missing.'
                : status.activity === 'idle'
                  ? 'No indexing work is waiting. New history will be indexed automatically.'
                  : 'Forge indexes new history automatically. Pausing stops indexing, not conversation recording.'}</p>
            </div>
            <Button variant={status.paused ? 'default' : 'outline'} disabled={updating} onClick={() => { void togglePaused() }}>
              {status.paused ? <Play className="mr-2 size-4" /> : <Pause className="mr-2 size-4" />}
              {updating ? 'Saving…' : status.paused ? 'Resume indexing' : 'Pause indexing'}
            </Button>
          </div>
          {status.error ? <p role="alert" className="mt-3 text-sm text-destructive">{status.error}</p> : null}
        </SettingsSection>
        <SettingsSection label="Indexing progress" description="Scanned bytes include content excluded from search. Sizes are rounded; matching totals do not mean all content is searchable.">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Metric label="Index on disk" value={bytes(status.storage.databaseBytes)} />
            <Metric label="Write-ahead log" value={bytes(status.storage.walBytes)} />
            <Metric label="Known transcript data" value={bytes(stats?.transcriptBytes)} />
            <Metric label="Transcript data scanned" value={bytes(stats?.processedBytes)} />
            <Metric label="Sources discovered" value={stats ? `${stats.discoveredSources.toLocaleString()} / ${status.eligibleSources?.toLocaleString() ?? 'discovering'}` : 'Unavailable'} />
            <Metric label="Discovered sources awaiting work" value={stats?.runnableSources.toLocaleString() ?? 'Unavailable'} />
          </dl>
        </SettingsSection>
        <SettingsSection label="Search availability" description="What can appear in search is separate from whether indexing has finished.">
          {!stats ? <p className="text-sm text-muted-foreground">Search availability could not be determined.</p> : hasSearchLimitations ? <div className="space-y-2 text-sm">
            <p className="font-medium">Some history is unavailable in search.</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {stats.unreadableSources > 0 ? <li>{stats.unreadableSources.toLocaleString()} source {stats.unreadableSources === 1 ? 'file is' : 'files are'} missing or could not be read.</li> : null}
              {stats.omittedSources > 0 ? <li>{stats.omittedSources.toLocaleString()} {stats.omittedSources === 1 ? 'source contains' : 'sources contain'} content excluded by indexing safety limits.</li> : null}
            </ul>
            {status.activity === 'idle' ? <p className="text-muted-foreground">Indexing has finished. These search limitations are not pending indexing work.</p> : null}
          </div> : <p className="text-sm text-muted-foreground">No missing files or content omissions detected in the indexed data.</p>}
        </SettingsSection>
        <SettingsSection label="About this index" description="The SQLite index is a rebuildable cache. Canonical conversation files remain the source of truth.">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Schema version</dt><dd>{status.schemaVersion}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Catalog discovery</dt><dd>{status.catalogHydration === 'complete' ? 'Complete' : 'In progress'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Last cache update</dt><dd>{stats?.lastUpdatedAt ? new Date(stats.lastUpdatedAt).toLocaleString() : 'Not yet available'}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">Refreshes every five seconds while this page is visible. Restricted runtimes, Remote Projects, and Collaboration history are not included.</p>
        </SettingsSection>
      </>}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-border/60 p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-medium tabular-nums">{value}</dd></div>
}

function bytes(value: number | null | undefined): string {
  if (value == null) return 'Unavailable'
  if (value === 0) return '0 B'
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
