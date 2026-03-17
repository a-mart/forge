import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  fetchCortexPromptSurfaceContent,
  resetCortexPromptSurface,
  saveCortexPromptSurface,
} from './prompt-api'
import { PromptEditor } from './PromptEditor'
import type {
  CortexPromptSurfaceContentResponse,
  CortexPromptSurfaceListEntry,
} from '@forge/protocol'

const GROUP_LABELS: Record<CortexPromptSurfaceListEntry['group'], string> = {
  system: 'System template',
  seed: 'Boot seed template',
  live: 'Live Cortex file',
  scratch: 'Scratch / supplemental',
}

const RUNTIME_EFFECT_LABELS: Record<CortexPromptSurfaceListEntry['runtimeEffect'], string> = {
  futureSeedOnly: 'Future seed only',
  liveImmediate: 'Live Cortex behavior',
  liveInjected: 'Live injected context',
  scratchOnly: 'Scratch / not injected',
}

const GROUP_BADGE_CLASSES: Record<CortexPromptSurfaceListEntry['group'], string> = {
  system: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  seed: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  live: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  scratch: 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300',
}

interface PromptSurfaceEditorProps {
  wsUrl: string
  profileId: string
  surface: CortexPromptSurfaceListEntry
  refreshKey: number
}

export function PromptSurfaceEditor({
  wsUrl,
  profileId,
  surface,
  refreshKey,
}: PromptSurfaceEditorProps) {
  if (surface.kind === 'registry' && surface.category && surface.promptId) {
    return (
      <div className="flex flex-col gap-4">
        <SurfaceHeader surface={surface} />
        <PromptEditor
          key={`${surface.surfaceId}:${profileId}:${refreshKey}`}
          wsUrl={wsUrl}
          category={surface.category}
          promptId={surface.promptId}
          profileId={profileId}
          displayName={surface.title}
          description={surface.description}
          refreshKey={refreshKey}
          hideTitleDescription
        />
      </div>
    )
  }

  return (
    <FilePromptSurfaceEditor
      wsUrl={wsUrl}
      profileId={profileId}
      surface={surface}
      refreshKey={refreshKey}
    />
  )
}

function SurfaceHeader({ surface }: { surface: CortexPromptSurfaceListEntry }) {
  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{surface.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{surface.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={GROUP_BADGE_CLASSES[surface.group]}>
            {GROUP_LABELS[surface.group]}
          </Badge>
          <Badge variant="outline">{RUNTIME_EFFECT_LABELS[surface.runtimeEffect]}</Badge>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 text-[11px] text-muted-foreground">
        {surface.sourcePath ? (
          <p className="break-all">
            Source: <span className="font-mono">{surface.sourcePath}</span>
          </p>
        ) : null}
        {surface.seedPrompt ? (
          <p>
            Seed relationship: <span className="font-mono">{surface.seedPrompt.category}/{surface.seedPrompt.promptId}</span>
          </p>
        ) : null}
        {surface.warning ? (
          <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
            {surface.warning}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FilePromptSurfaceEditor({
  wsUrl,
  profileId,
  surface,
  refreshKey,
}: PromptSurfaceEditorProps) {
  const [entry, setEntry] = useState<CortexPromptSurfaceContentResponse | null>(null)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [pendingRemoteEntry, setPendingRemoteEntry] = useState<CortexPromptSurfaceContentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const successTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const contentRef = useRef(content)
  const originalContentRef = useRef(originalContent)

  const isDirty = content !== originalContent
  const canReset = entry?.resetMode === 'reseedFromTemplate'

  const applyLoadedEntry = useCallback((nextEntry: CortexPromptSurfaceContentResponse) => {
    setEntry(nextEntry)
    setContent(nextEntry.content)
    setOriginalContent(nextEntry.content)
    setPendingRemoteEntry(null)
  }, [])

  useEffect(() => {
    contentRef.current = content
  }, [content])

  useEffect(() => {
    originalContentRef.current = originalContent
  }, [originalContent])

  const loadContent = useCallback(async (options?: { preserveDirty?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCortexPromptSurfaceContent(wsUrl, surface.surfaceId, profileId)
      if (options?.preserveDirty && contentRef.current !== originalContentRef.current) {
        if (data.content !== originalContentRef.current) {
          setEntry((current) => current ? { ...current, ...data } : data)
          setPendingRemoteEntry(data)
          return
        }

        setEntry((current) => current ? { ...current, ...data } : data)
        return
      }
      applyLoadedEntry(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Cortex prompt surface')
    } finally {
      setLoading(false)
    }
  }, [wsUrl, surface.surfaceId, profileId, applyLoadedEntry])

  useEffect(() => {
    void loadContent()
  }, [loadContent, refreshKey])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadContent({ preserveDirty: true })
      }
    }
    const handleFocus = () => {
      void loadContent({ preserveDirty: true })
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [loadContent])

  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current)
    }
  }, [])

  const showSuccess = (message: string) => {
    setSuccessMessage(message)
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = setTimeout(() => setSuccessMessage(null), 3000)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveCortexPromptSurface(wsUrl, surface.surfaceId, content, profileId)
      const data = await fetchCortexPromptSurfaceContent(wsUrl, surface.surfaceId, profileId)
      applyLoadedEntry(data)
      showSuccess('Surface saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Cortex prompt surface')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setResetting(true)
    setError(null)
    try {
      await resetCortexPromptSurface(wsUrl, surface.surfaceId, profileId)
      const data = await fetchCortexPromptSurfaceContent(wsUrl, surface.surfaceId, profileId)
      applyLoadedEntry(data)
      showSuccess('Live file reseeded from template.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset Cortex prompt surface')
    } finally {
      setResetting(false)
    }
  }

  const reloadRemoteChanges = () => {
    if (!pendingRemoteEntry) return
    applyLoadedEntry(pendingRemoteEntry)
  }

  const lastModifiedLabel = useMemo(() => {
    if (!entry?.lastModifiedAt) return null
    const date = new Date(entry.lastModifiedAt)
    return Number.isNaN(date.getTime()) ? entry.lastModifiedAt : date.toLocaleString()
  }, [entry?.lastModifiedAt])

  if (loading && !entry) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    )
  }

  if (error && !entry) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void loadContent()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {entry ? <SurfaceHeader surface={entry} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {lastModifiedLabel ? (
          <Badge variant="outline">Updated {lastModifiedLabel}</Badge>
        ) : null}
        {isDirty ? (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Unsaved changes
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void loadContent({ preserveDirty: true })}
          disabled={loading}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        {canReset ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleReset()}
            disabled={resetting}
          >
            {resetting ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 size-3" />
            )}
            Reseed from Template
          </Button>
        ) : null}
        {entry?.editable ? (
          <Button size="sm" onClick={() => void handleSave()} disabled={!isDirty || saving}>
            {saving ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3" />
            )}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        ) : null}
      </div>

      {pendingRemoteEntry ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span>New file content is available. Reload to replace your local edits.</span>
          <Button variant="outline" size="sm" className="h-7" onClick={reloadRemoteChanges}>
            Reload latest
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}
      {successMessage ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{successMessage}</p>
        </div>
      ) : null}

      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="min-h-[400px] font-mono text-sm leading-relaxed resize-y"
        spellCheck={false}
        readOnly={!entry?.editable}
      />
    </div>
  )
}
