import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { slugifySessionName } from '../agent-sidebar/utils'
import { PROJECT_AGENT_WHEN_TO_USE_MAX } from '../agent-sidebar/constants'
import { ProjectAgentReferenceDocsEditor } from './ProjectAgentReferenceDocsEditor'
import type { ProjectAgentSettingsSheetProps } from '../agent-sidebar/types'

export function ProjectAgentSettingsSheet({
  agentId,
  sessionLabel,
  currentProjectAgent,
  onSave,
  onDemote,
  onClose,
  onGetProjectAgentConfig,
  onListReferences,
  onGetReference,
  onSetReference,
  onDeleteReference,
  onRequestRecommendations,
}: ProjectAgentSettingsSheetProps) {
  const isPromoting = !currentProjectAgent

  const [handleInput, setHandleInput] = useState(slugifySessionName(sessionLabel))
  const normalizedHandle = slugifySessionName(handleInput)

  const [configLoading, setConfigLoading] = useState(!isPromoting)
  const [configError, setConfigError] = useState<string | null>(null)
  const fetchedSystemPromptRef = useRef<string>('')

  const [whenToUse, setWhenToUse] = useState(currentProjectAgent?.whenToUse ?? '')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [referenceDocs, setReferenceDocs] = useState<string[]>([])
  const [expandedReferenceFile, setExpandedReferenceFile] = useState<string | null>(null)
  const [referenceContents, setReferenceContents] = useState<Record<string, string>>({})
  const [loadedReferenceFiles, setLoadedReferenceFiles] = useState<Set<string>>(() => new Set())
  const [loadingReferenceFiles, setLoadingReferenceFiles] = useState<Set<string>>(() => new Set())
  const [savingReferenceFiles, setSavingReferenceFiles] = useState<Set<string>>(() => new Set())
  const [dirtyReferenceFiles, setDirtyReferenceFiles] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const whenToUseDirtyRef = useRef(false)
  const systemPromptDirtyRef = useRef(false)

  const refreshReferenceDocs = useCallback(async () => {
    if (!onListReferences) return
    const result = await onListReferences(agentId)
    setReferenceDocs(result.references)
    setExpandedReferenceFile((previous) => (
      previous && !result.references.includes(previous) ? null : previous
    ))
  }, [agentId, onListReferences])

  useEffect(() => {
    if (isPromoting || !onGetProjectAgentConfig) return
    let cancelled = false
    setConfigLoading(true)
    setConfigError(null)
    void onGetProjectAgentConfig(agentId).then((result) => {
      if (cancelled) return
      const prompt = result.systemPrompt ?? ''
      fetchedSystemPromptRef.current = prompt
      if (!systemPromptDirtyRef.current) {
        setSystemPrompt(prompt)
      }
      setReferenceDocs(result.references)
      setConfigLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setConfigError(err instanceof Error ? err.message : 'Failed to load config.')
      setConfigLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, isPromoting])

  const trimmedWhenToUse = whenToUse.trim()
  const trimmedSystemPrompt = systemPrompt.trim()
  const canSave = isPromoting
    ? trimmedWhenToUse.length > 0 && trimmedWhenToUse.length <= PROJECT_AGENT_WHEN_TO_USE_MAX && normalizedHandle.length > 0
    : trimmedWhenToUse.length > 0 && trimmedWhenToUse.length <= PROJECT_AGENT_WHEN_TO_USE_MAX
  const hasChanges = isPromoting
    || trimmedWhenToUse !== (currentProjectAgent?.whenToUse ?? '')
    || trimmedSystemPrompt !== fetchedSystemPromptRef.current.trim()

  const requestRecommendations = useCallback(async (replaceExisting: boolean) => {
    if (!onRequestRecommendations) return
    setAnalyzing(true)
    setAnalysisError(null)
    try {
      const result = await onRequestRecommendations(agentId)
      if (replaceExisting) {
        setWhenToUse(result.whenToUse)
        setSystemPrompt(result.systemPrompt)
        whenToUseDirtyRef.current = false
        systemPromptDirtyRef.current = false
      } else {
        if (!whenToUseDirtyRef.current) {
          setWhenToUse(result.whenToUse)
        }
        if (!systemPromptDirtyRef.current) {
          setSystemPrompt(result.systemPrompt)
        }
      }
    } catch {
      setAnalysisError('AI analysis failed — you can fill in the fields manually.')
    } finally {
      setAnalyzing(false)
    }
  }, [agentId, onRequestRecommendations])

  useEffect(() => {
    if (isPromoting && onRequestRecommendations) {
      void requestRecommendations(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadReference = useCallback(async (fileName: string) => {
    if (!onGetReference) return
    setReferenceError(null)
    setLoadingReferenceFiles((prev) => new Set(prev).add(fileName))
    try {
      const result = await onGetReference(agentId, fileName)
      setReferenceContents((prev) => ({
        ...prev,
        [fileName]: prev[fileName] ?? result.content,
      }))
      setLoadedReferenceFiles((prev) => new Set(prev).add(fileName))
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to load ${fileName}.`)
    } finally {
      setLoadingReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
  }, [agentId, onGetReference])

  const handleWhenToUseChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    whenToUseDirtyRef.current = true
    setWhenToUse(e.target.value)
  }, [])

  const handleSystemPromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    systemPromptDirtyRef.current = true
    setSystemPrompt(e.target.value)
  }, [])

  const handleToggleReference = useCallback((fileName: string) => {
    setExpandedReferenceFile((previous) => previous === fileName ? null : fileName)
    if (!loadedReferenceFiles.has(fileName) && !loadingReferenceFiles.has(fileName)) {
      void loadReference(fileName)
    }
  }, [loadReference, loadedReferenceFiles, loadingReferenceFiles])

  const handleReferenceContentChange = useCallback((fileName: string, nextContent: string) => {
    setReferenceContents((prev) => ({ ...prev, [fileName]: nextContent }))
    setDirtyReferenceFiles((prev) => new Set(prev).add(fileName))
  }, [])

  const handleSaveReference = useCallback(async (fileName: string) => {
    if (!onSetReference) return
    setReferenceError(null)
    setSavingReferenceFiles((prev) => new Set(prev).add(fileName))
    try {
      await onSetReference(agentId, fileName, referenceContents[fileName] ?? '')
      setDirtyReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      await refreshReferenceDocs()
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to save ${fileName}.`)
    } finally {
      setSavingReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
  }, [agentId, onSetReference, referenceContents, refreshReferenceDocs])

  const handleDeleteReference = useCallback(async (fileName: string) => {
    if (!onDeleteReference) return
    if (typeof window !== 'undefined' && !window.confirm(`Delete reference document \"${fileName}\"?`)) {
      return
    }

    setReferenceError(null)
    setSavingReferenceFiles((prev) => new Set(prev).add(fileName))
    try {
      await onDeleteReference(agentId, fileName)
      setReferenceDocs((prev) => prev.filter((entry) => entry !== fileName))
      setExpandedReferenceFile((prev) => prev === fileName ? null : prev)
      setReferenceContents((prev) => {
        const next = { ...prev }
        delete next[fileName]
        return next
      })
      setLoadedReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      setDirtyReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      await refreshReferenceDocs()
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to delete ${fileName}.`)
    } finally {
      setSavingReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
  }, [agentId, onDeleteReference, refreshReferenceDocs])

  const handleAddReference = useCallback(async () => {
    if (!onSetReference) return
    const requestedFileName = typeof window !== 'undefined'
      ? window.prompt('Reference document filename', 'notes.md')
      : null
    const fileName = requestedFileName?.trim()
    if (!fileName) {
      return
    }

    setReferenceError(null)
    try {
      await onSetReference(agentId, fileName, '')
      await refreshReferenceDocs()
      setReferenceContents((prev) => ({ ...prev, [fileName]: prev[fileName] ?? '' }))
      setLoadedReferenceFiles((prev) => new Set(prev).add(fileName))
      setExpandedReferenceFile(fileName)
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to create ${fileName}.`)
    }
  }, [agentId, onSetReference, refreshReferenceDocs])

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave(agentId, {
        whenToUse: trimmedWhenToUse,
        ...(trimmedSystemPrompt ? { systemPrompt: trimmedSystemPrompt } : {}),
        ...(isPromoting && normalizedHandle ? { handle: normalizedHandle } : {}),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project agent settings.')
    } finally {
      setSaving(false)
    }
  }

  const handleDemote = async () => {
    setSaving(true)
    setError(null)
    try {
      await onDemote(agentId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to demote project agent.')
    } finally {
      setSaving(false)
    }
  }

  const referenceEditingAvailable = !isPromoting && !!onGetReference && !!onSetReference && !!onDeleteReference

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        side="right"
        className={cn(
          'max-w-[90vw] overflow-y-auto',
          '[color-scheme:light] dark:[color-scheme:dark]',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
          '[&::-webkit-scrollbar-thumb:hover]:bg-border/80',
        )}
        style={{ width: 600, maxWidth: '90vw', scrollbarWidth: 'thin', scrollbarColor: 'hsl(var(--border)) transparent' }}
      >
        <SheetHeader>
          <SheetTitle>{isPromoting ? 'Promote to Project Agent' : 'Project Agent Settings'}</SheetTitle>
          <SheetDescription>
            {isPromoting
              ? 'Make this session discoverable by other sessions in the same profile.'
              : 'Configure how other sessions discover and interact with this project agent.'}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Session</label>
            <p className="text-sm text-muted-foreground">{sessionLabel}</p>
          </div>

          {isPromoting ? (
            <div className="space-y-1.5">
              <label htmlFor="agentHandle" className="text-sm font-medium text-foreground">Handle</label>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">@</span>
                <Input
                  id="agentHandle"
                  value={handleInput}
                  onChange={(e) => setHandleInput(e.target.value)}
                  placeholder="agent-handle"
                  className="font-mono text-sm"
                />
              </div>
              {handleInput && normalizedHandle !== handleInput ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  Normalized: @{normalizedHandle || <span className="text-amber-500">(empty)</span>}
                </p>
              ) : null}
              {handleInput && !normalizedHandle ? (
                <p className="text-[11px] text-amber-500">
                  Handle must contain at least one letter, number, or dash.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Handle</label>
              <p className="font-mono text-sm text-muted-foreground">
                @{currentProjectAgent?.handle}
              </p>
            </div>
          )}

          {configLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>Loading configuration…</span>
            </div>
          ) : null}

          {configError ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              {configError}
            </p>
          ) : null}

          {analyzing ? (
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>Analyzing session to generate recommendations…</span>
            </div>
          ) : null}

          {analysisError ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              {analysisError}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="whenToUse" className="text-sm font-medium text-foreground">When to use</label>
            <Textarea
              id="whenToUse"
              value={whenToUse}
              onChange={handleWhenToUseChange}
              placeholder={analyzing ? 'Generating recommendation…' : 'Describe when other sessions should send messages to this agent…'}
              rows={3}
              maxLength={PROJECT_AGENT_WHEN_TO_USE_MAX}
              className="resize-none"
              autoFocus={!analyzing}
            />
            <p className="text-[11px] text-muted-foreground">
              {trimmedWhenToUse.length}/{PROJECT_AGENT_WHEN_TO_USE_MAX}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="systemPrompt" className="text-sm font-medium text-foreground">
              System Prompt
              <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="systemPrompt"
              value={systemPrompt}
              onChange={handleSystemPromptChange}
              placeholder={configLoading ? 'Loading…' : analyzing ? 'Generating recommendation…' : 'Custom system prompt for this project agent…'}
              rows={8}
              className="resize-y font-mono text-xs"
              disabled={configLoading}
            />
            <p className="text-[11px] text-muted-foreground">
              When set, this replaces the standard manager prompt for this session.
            </p>
          </div>

          <ProjectAgentReferenceDocsEditor
            isPromoting={isPromoting}
            referenceDocs={referenceDocs}
            expandedReferenceFile={expandedReferenceFile}
            referenceContents={referenceContents}
            loadingReferenceFiles={loadingReferenceFiles}
            savingReferenceFiles={savingReferenceFiles}
            dirtyReferenceFiles={dirtyReferenceFiles}
            referenceError={referenceError}
            saving={saving}
            configLoading={configLoading}
            onToggleReference={handleToggleReference}
            onReferenceContentChange={handleReferenceContentChange}
            onSaveReference={handleSaveReference}
            onDeleteReference={handleDeleteReference}
            onAddReference={handleAddReference}
            referenceEditingAvailable={referenceEditingAvailable}
          />

          {!isPromoting && onRequestRecommendations ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void requestRecommendations(true)}
              disabled={analyzing || configLoading}
              className="gap-1.5"
            >
              {analyzing
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Sparkles className="size-3.5" />
              }
              Regenerate recommendations
            </Button>
          ) : null}

          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!canSave || !hasChanges || saving || configLoading}>
              {saving ? 'Saving…' : isPromoting ? 'Promote' : 'Save'}
            </Button>
            {!isPromoting ? (
              <Button variant="outline" onClick={handleDemote} disabled={saving} className="text-destructive hover:text-destructive">
                Demote
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
