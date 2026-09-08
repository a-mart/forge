import { useEffect, useRef, useState } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import { isSessionContextArtifacts, type ContextArtifactFile, type SessionContextArtifacts } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { MarkdownMessage } from '../MarkdownMessage'

const descriptions = {
  checkpoint: 'The agent’s saved handoff for continuing work in a new context window.',
  working: 'Working notes the agent can retrieve as it continues this session.',
  recovery: 'A runtime-generated recovery record used during a context transition. Older records may be replaced.',
}

function timestamp(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown update time' : date.toLocaleString()
}

function useContextArtifacts(wsUrl: string, managerId: string) {
  const [data, setData] = useState<SessionContextArtifacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => { void load() }, 10_000)
        return
      }
      try {
        const response = await fetch(resolveApiEndpoint(wsUrl,
          `/api/agents/${encodeURIComponent(managerId)}/context-artifacts`), {
          signal: controller.signal, credentials: 'include', cache: 'no-store',
        })
        if (!response.ok) throw new Error(response.status === 404
          ? 'Context files are unavailable for this session or server.' : 'Unable to refresh context files. Try again.')
        const payload: unknown = await response.json()
        if (!isSessionContextArtifacts(payload) || payload.contextMode.sessionAgentId !== managerId) {
          throw new Error('Invalid context files response.')
        }
        if (!controller.signal.aborted) { setData(payload); setError(null) }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load context files.')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
          timer = setTimeout(() => { void load() }, 10_000)
        }
      }
    }
    setLoading(true)
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [wsUrl, managerId, refresh])
  return { data, error, loading, refresh: () => setRefresh(value => value + 1) }
}

/** Mounted only for the visible Artifacts tab, keyed by server and manager by its caller. */
export function ContextArtifactsSection({ wsUrl, managerId }: { wsUrl: string; managerId: string }) {
  const { data, error, loading, refresh } = useContextArtifacts(wsUrl, managerId)
  const opener = useRef<HTMLButtonElement | null>(null)
  const refreshButton = useRef<HTMLButtonElement | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)
  const selected = data?.files.find(file => file.path === selectedPath)
  const mode = data?.contextMode
  const applied = mode?.appliedMode ?? (mode?.freshSupported ? mode.effectiveMode : 'summary')
  const groups = [
    { title: 'Task notes', files: data?.files.filter(file => file.kind !== 'recovery') ?? [] },
    { title: 'Window recovery', files: data?.files.filter(file => file.kind === 'recovery') ?? [] },
  ]
  return (
    <section className="border-b border-border/60 p-3" aria-label="Context v2 files">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">Context v2</h3>
        <Button ref={refreshButton} variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={loading} aria-label="Refresh context files">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">Session notes and window recovery files. Read-only; separate from long-term memory.</p>
      {mode && <p className="mt-2 text-[11px] text-muted-foreground">
        Using {applied === 'fresh' ? 'Context v2' : 'Summary'}
        {mode.effectiveMode !== applied && ` · ${mode.effectiveMode === 'fresh' ? 'Context v2' : 'Summary'} saved for a supported transition`}
      </p>}
      {mode?.unsupportedReason && <p className="mt-1 text-[11px] text-muted-foreground">{mode.unsupportedReason}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}{data ? ' Showing the last loaded version.' : ''}</p>}
      {loading && !data && <p role="status" className="mt-3 text-xs text-muted-foreground">Loading context files…</p>}
      {data && !data.files.length && <p className="mt-3 text-xs text-muted-foreground">No context files saved yet. They appear when the agent writes notes or prepares a context transition.</p>}
      {groups.map(group => group.files.length > 0 && <div key={group.title} className="mt-3">
        <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{group.title}</h4>
        {group.files.map(file => <button key={file.path} type="button"
          className="flex w-full min-w-0 items-start gap-2 rounded-md p-2 text-left hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={event => { opener.current = event.currentTarget; setSelectedPath(file.path); setRaw(false) }}>
          <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block break-all text-xs font-medium">{file.path}</span>
            <span className="block text-[10px] text-muted-foreground">Revision {file.revision} · {file.bytes.toLocaleString()} bytes</span>
            <time className="block text-[10px] text-muted-foreground" dateTime={file.updatedAt}>{timestamp(file.updatedAt)}</time>
          </span>
        </button>)}
      </div>)}
      {data && data.files.length > 0 && <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">Manager’s notes · refreshes while open. Notes survive context transitions; clearing the conversation removes them.</p>}
      <Dialog open={selectedPath !== null} onOpenChange={open => { if (!open) setSelectedPath(null) }}>
        <DialogContent onCloseAutoFocus={event => {
          event.preventDefault()
          ;(opener.current?.isConnected ? opener.current : refreshButton.current)?.focus()
        }} className="flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl flex-col gap-3 p-4 sm:p-6">
          <DialogTitle className="break-all pr-7 text-base">{selectedPath}</DialogTitle>
          <DialogDescription>{selected ? descriptions[selected.kind] : 'This file is no longer present. It may have been replaced or the conversation cleared.'}</DialogDescription>
          {error && <p role="status" className="text-xs text-destructive">The latest refresh failed. This is the last loaded version.</p>}
          {selected && <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <p className="text-xs text-muted-foreground">Revision {selected.revision} · {selected.bytes.toLocaleString()} bytes · {timestamp(selected.updatedAt)}</p>
              <Button variant="outline" size="sm" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? 'Show formatted' : 'Show source'}</Button>
            </div>
            <NoteContent file={selected} raw={raw} />
            <details className="text-[10px] text-muted-foreground"><summary>Content fingerprint</summary><code className="block break-all pt-1">SHA-256 {selected.digest}</code></details>
          </>}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function NoteContent({ file, raw }: { file: ContextArtifactFile; raw: boolean }) {
  return <div className="min-h-0 overflow-auto overscroll-contain [overflow-wrap:anywhere]" aria-label="Context file contents">
    {!file.text ? <p className="text-sm text-muted-foreground">This file is empty.</p> : raw || !/\.md$/i.test(file.path)
      ? <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{file.text}</pre>
      : <MarkdownMessage content={file.text} variant="document" />}
  </div>
}
