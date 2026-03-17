import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { PromptSourceIndicator } from './PromptSourceIndicator'
import { PromptVariablePanel } from './PromptVariablePanel'
import { fetchPromptContent, savePromptOverride, deletePromptOverride } from './prompt-api'
import type { PromptCategory, PromptContentResponse } from '@forge/protocol'

interface PromptEditorProps {
  wsUrl: string
  category: PromptCategory
  promptId: string
  profileId: string
  displayName: string
  description: string
  /** Bumped externally when a prompt_changed WS event arrives */
  refreshKey: number
  hideTitleDescription?: boolean
}

export function PromptEditor({
  wsUrl,
  category,
  promptId,
  profileId,
  displayName,
  description,
  refreshKey,
  hideTitleDescription = false,
}: PromptEditorProps) {
  const [entry, setEntry] = useState<PromptContentResponse | null>(null)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const successTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const isDirty = content !== originalContent
  const hasOverride = entry?.sourceLayer === 'profile'

  const loadContent = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchPromptContent(wsUrl, category, promptId, profileId)
      setEntry(data)
      setContent(data.content)
      setOriginalContent(data.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompt')
    } finally {
      setLoading(false)
    }
  }, [wsUrl, category, promptId, profileId])

  useEffect(() => {
    void loadContent()
  }, [loadContent, refreshKey])

  // Clean up success timer
  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current)
    }
  }, [])

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg)
    if (successTimer.current) clearTimeout(successTimer.current)
    successTimer.current = setTimeout(() => setSuccessMessage(null), 3000)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await savePromptOverride(wsUrl, category, promptId, content, profileId)
      setOriginalContent(content)
      // Re-fetch to get updated source layer
      const data = await fetchPromptContent(wsUrl, category, promptId, profileId)
      setEntry(data)
      showSuccess('Prompt saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setResetting(true)
    setError(null)
    try {
      await deletePromptOverride(wsUrl, category, promptId, profileId)
      // Re-fetch to get fallback content
      const data = await fetchPromptContent(wsUrl, category, promptId, profileId)
      setEntry(data)
      setContent(data.content)
      setOriginalContent(data.content)
      showSuccess('Reset to default.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset')
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
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
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {!hideTitleDescription ? (
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{displayName}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-2">
          {hasOverride && (
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
              Reset to Default
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3" />
            )}
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Source indicator + dirty badge */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {entry && <PromptSourceIndicator sourceLayer={entry.sourceLayer} />}
          {isDirty && (
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
              Unsaved changes
            </span>
          )}
        </div>
        {entry?.sourcePath ? (
          <p className="text-[11px] text-muted-foreground break-all">
            Source: <span className="font-mono">{entry.sourcePath}</span>
          </p>
        ) : null}
      </div>

      {/* Feedback banners */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
      {successMessage && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{successMessage}</p>
        </div>
      )}

      {/* Editor */}
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="min-h-[400px] font-mono text-sm leading-relaxed resize-y"
        spellCheck={false}
      />

      {/* Variable reference */}
      {entry && entry.variables.length > 0 && (
        <PromptVariablePanel variables={entry.variables} />
      )}
    </div>
  )
}
