import { useCallback, useEffect, useRef, useState } from 'react'
import { isRepoProjectAgentSource, type ProjectAgentConfigSourceSnapshot, type RepoProjectAgentSourceIdentity } from '@forge/protocol'
import { AlertTriangle, GitBranch, Loader2, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useDrawerResize } from '@/hooks/use-drawer-resize'
import { slugifySessionName } from '../agent-sidebar/utils'
import { PROJECT_AGENT_WHEN_TO_USE_MAX } from '../agent-sidebar/constants'
import { ProjectAgentReferenceDocsEditor } from './ProjectAgentReferenceDocsEditor'
import { DiscardChangesDialog } from './DiscardChangesDialog'
import type { ProjectAgentSettingsSheetProps } from '../agent-sidebar/types'

const SHEET_STORAGE_KEY = 'forge-project-agent-sheet-width'
const DEFAULT_WIDTH = 720
const MIN_WIDTH = 500
const MAX_WIDTH = 1200

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
  const repoSource: RepoProjectAgentSourceIdentity | null =
    currentProjectAgent?.source && isRepoProjectAgentSource(currentProjectAgent.source)
      ? currentProjectAgent.source
      : null
  const isRepoSourced = repoSource !== null || currentProjectAgent?.sourceKind === 'repo'
  const repoSourcePath = repoSource?.forgeDirRealpath ?? null

  const [handleInput, setHandleInput] = useState(slugifySessionName(sessionLabel))
  const normalizedHandle = slugifySessionName(handleInput)

  const [configLoading, setConfigLoading] = useState(!isPromoting)
  const [configError, setConfigError] = useState<string | null>(null)
  const [sourceSnapshot, setSourceSnapshot] = useState<ProjectAgentConfigSourceSnapshot | null>(null)
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
  const [canCreateSessions, setCanCreateSessions] = useState(
    currentProjectAgent?.capabilities?.includes('create_session') ?? false,
  )
  const [saving, setSaving] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDiscardDialog, setShowDiscardDialog] = useState(false)

  const whenToUseDirtyRef = useRef(false)
  const systemPromptDirtyRef = useRef(false)

  const { width: drawerWidth, isResizing, handleResizeStart } = useDrawerResize({
    storageKey: SHEET_STORAGE_KEY,
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
  })

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
      setCanCreateSessions(result.config.capabilities?.includes('create_session') ?? false)
      setReferenceDocs(result.references)
      if (result.source) {
        setSourceSnapshot(result.source)
      }
      // For repo-sourced agents, only show live config when the repo source is valid.
      // Missing/invalid sources must not display stale descriptor values as editable-looking truth.
      if (isRepoSourced) {
        setWhenToUse(result.source?.status === 'valid' ? result.config.whenToUse : '')
      }
      setConfigLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setConfigError(err instanceof Error ? err.message : 'Failed to load config.')
      setConfigLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, isPromoting])

  // Source diagnostics: use the live snapshot when available, fall back to descriptor identity
  const effectiveSourcePath = sourceSnapshot?.forgeDirRealpath ?? repoSourcePath
  const effectiveDefinitionId = sourceSnapshot?.definitionId ?? repoSource?.definitionId ?? null
  const sourceStatus = sourceSnapshot?.status ?? (isRepoSourced ? 'valid' : null)
  const sourceProblems = sourceSnapshot?.problems ?? []
  const isSourceHealthy = !sourceStatus || sourceStatus === 'valid'

  const trimmedWhenToUse = whenToUse.trim()
  const trimmedSystemPrompt = systemPrompt.trim()
  const canSave = isPromoting
    ? trimmedWhenToUse.length > 0 && trimmedWhenToUse.length <= PROJECT_AGENT_WHEN_TO_USE_MAX && normalizedHandle.length > 0
    : !isRepoSourced && trimmedWhenToUse.length > 0 && trimmedWhenToUse.length <= PROJECT_AGENT_WHEN_TO_USE_MAX
  const storedCanCreateSessions = currentProjectAgent?.capabilities?.includes('create_session') ?? false
  const hasChanges = isPromoting
    || (!isRepoSourced && (
      trimmedWhenToUse !== (currentProjectAgent?.whenToUse ?? '')
      || trimmedSystemPrompt !== fetchedSystemPromptRef.current.trim()
      || canCreateSessions !== storedCanCreateSessions
    ))

  // Dirty state: would closing lose user-entered data?
  const isDirty = isPromoting
    ? (trimmedWhenToUse.length > 0 || trimmedSystemPrompt.length > 0)
    : (!isRepoSourced && (hasChanges || dirtyReferenceFiles.size > 0))

  // ── Close flow: confirm if dirty, otherwise close immediately ──

  const handleRequestClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardDialog(true)
    } else {
      onClose()
    }
  }, [isDirty, onClose])

  const handleConfirmDiscard = useCallback(() => {
    setShowDiscardDialog(false)
    onClose()
  }, [onClose])

  const handleCancelDiscard = useCallback(() => {
    setShowDiscardDialog(false)
  }, [])

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
    if (typeof window !== 'undefined' && !window.confirm(`Delete reference document "${fileName}"?`)) {
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

  const handleAddReference = useCallback(async (fileName: string, content: string) => {
    if (!onSetReference) return

    setReferenceError(null)
    try {
      await onSetReference(agentId, fileName, content)
      await refreshReferenceDocs()
      setReferenceContents((prev) => ({ ...prev, [fileName]: content }))
      setLoadedReferenceFiles((prev) => new Set(prev).add(fileName))
      setDirtyReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      setExpandedReferenceFile(null)
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to create ${fileName}.`)
      throw err
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
        capabilities: canCreateSessions ? ['create_session'] : [],
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
      setError(err instanceof Error ? err.message : isRepoSourced ? 'Failed to deactivate repository Project Agent.' : 'Failed to demote project agent.')
    } finally {
      setSaving(false)
    }
  }

  const referenceEditingAvailable = !isPromoting && !isRepoSourced && !!onGetReference && !!onSetReference && !!onDeleteReference

  return (
    <>
      <Sheet open onOpenChange={(open) => { if (!open) handleRequestClose() }}>
        <SheetContent
          side="right"
          className={cn(
            'overflow-y-auto',
            '[color-scheme:light] dark:[color-scheme:dark]',
            '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
            '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
            '[&::-webkit-scrollbar-thumb:hover]:bg-border/80',
          )}
          style={{
            width: drawerWidth,
            maxWidth: drawerWidth,
            scrollbarWidth: 'thin',
            scrollbarColor: 'hsl(var(--border)) transparent',
          }}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            handleRequestClose()
          }}
        >
          {/* Resize handle on left edge (desktop only) */}
          <div
            className={cn(
              'absolute left-0 top-0 bottom-0 z-10 hidden w-1.5 cursor-col-resize select-none sm:block',
              'hover:bg-primary/20',
              isResizing && 'bg-primary/30',
            )}
            onMouseDown={handleResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuenow={drawerWidth}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
          />

          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {isPromoting ? 'Promote to Project Agent' : 'Project Agent Settings'}
              {isRepoSourced ? (
                <Badge variant="secondary" className="gap-1 text-[10px] font-normal">
                  <GitBranch className="h-3 w-3" />
                  Repository
                </Badge>
              ) : null}
            </SheetTitle>
            <SheetDescription>
              {isPromoting
                ? 'Make this session discoverable by other sessions in the same profile.'
                : isRepoSourced
                  ? 'This agent is defined in the repository. Configuration is read-only and sourced from the repo definition files.'
                  : 'Configure how other sessions discover and interact with this project agent.'}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4">
            {isRepoSourced ? (
              isSourceHealthy ? (
                <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <GitBranch className="h-3.5 w-3.5 text-blue-400" />
                    Repository source
                  </div>
                  {effectiveSourcePath ? (
                    <p className="break-all text-xs text-muted-foreground">{effectiveSourcePath}</p>
                  ) : null}
                  <p className="text-[11px] text-muted-foreground">
                    Prompt is read live from <code>.forge/project-agents/{effectiveDefinitionId ?? currentProjectAgent?.handle}/prompt.md</code>.
                    Edit the file directly to update the agent prompt.
                  </p>
                </div>
              ) : (
                <div data-testid="source-status-banner" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Repository source {sourceStatus === 'missing' ? 'missing' : sourceStatus === 'wrong_workspace' ? 'workspace mismatch' : sourceStatus === 'unavailable' ? 'unavailable' : sourceStatus === 'invalid' ? 'invalid' : 'error'}
                  </div>
                  {effectiveSourcePath ? (
                    <p className="break-all text-xs text-muted-foreground">{effectiveSourcePath}</p>
                  ) : null}
                  {effectiveDefinitionId ? (
                    <p className="text-[11px] text-muted-foreground">
                      Definition: <code>{effectiveDefinitionId}</code>
                    </p>
                  ) : null}
                  {sourceProblems.length > 0 ? (
                    <ul className="space-y-0.5">
                      {sourceProblems.map((problem, i) => (
                        <li key={i} className="text-xs text-amber-600 dark:text-amber-400">
                          {problem.message}{problem.path ? <> — <code className="text-[10px]">{problem.path}</code></> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {sourceStatus === 'missing'
                        ? 'The repo definition directory for this agent no longer exists. Re-create the definition files or deactivate the agent.'
                        : sourceStatus === 'wrong_workspace'
                          ? 'This agent was activated from a different workspace. Switch to the original workspace or re-activate.'
                          : sourceStatus === 'unavailable'
                            ? 'The repository .forge directory is not accessible. Verify the workspace path and try again.'
                            : 'The repo definition has validation errors. Check config.json and prompt.md.'}
                    </p>
                  )}
                </div>
              )
            ) : null}
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
                autoFocus={!analyzing && !isRepoSourced}
                readOnly={isRepoSourced}
                disabled={isRepoSourced}
              />
              {!isRepoSourced ? (
                <p className="text-[11px] text-muted-foreground">
                  {trimmedWhenToUse.length}/{PROJECT_AGENT_WHEN_TO_USE_MAX}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Defined in <code>config.json</code>. Edit the repo file to change.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="systemPrompt" className="text-sm font-medium text-foreground">
                {isRepoSourced ? 'Role Instructions' : (
                  <>
                    Role Instructions
                    <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
                  </>
                )}
              </label>
              <Textarea
                id="systemPrompt"
                value={systemPrompt}
                onChange={handleSystemPromptChange}
                placeholder={
                  configLoading
                    ? 'Loading…'
                    : analyzing
                      ? 'Generating recommendation…'
                      : isRepoSourced
                        ? 'No role instructions loaded.'
                        : 'Role, scope, constraints, and validation habits for this project agent…'
                }
                rows={8}
                className="resize-y font-mono text-xs"
                disabled={configLoading || isRepoSourced}
                readOnly={isRepoSourced}
              />
              <p className="text-[11px] text-muted-foreground">
                {isRepoSourced
                  ? 'Read live from prompt.md in the repo definition directory as role instructions. Forge adds the Project Agent base prompt automatically.'
                  : 'Use this for role, scope, constraints, and validation habits. Forge layers it after the Project Agent base prompt automatically.'}
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Capabilities</label>
              <div className="flex items-start gap-3">
                <Switch
                  id="canCreateSessions"
                  checked={canCreateSessions}
                  onCheckedChange={isRepoSourced ? undefined : setCanCreateSessions}
                  className="mt-0.5"
                  size="sm"
                  disabled={isRepoSourced}
                />
                <div className="space-y-0.5">
                  <label htmlFor="canCreateSessions" className="text-sm text-foreground">
                    Can create sessions
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    {isRepoSourced
                      ? 'Approved at activation from config.json. Re-activate or link again to change capabilities.'
                      : 'Allow this agent to create new manager sessions in the same profile.'}
                  </p>
                </div>
              </div>
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
              readOnly={isRepoSourced}
              readOnlyReason={isRepoSourced ? 'Repository reference documents are read from .forge/project-agents/<definitionId>/reference and cannot be edited here.' : undefined}
            />

            {!isPromoting && !isRepoSourced && onRequestRecommendations ? (
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
              {!isRepoSourced ? (
                <Button onClick={handleSave} disabled={!canSave || !hasChanges || saving || configLoading}>
                  {saving ? 'Saving…' : isPromoting ? 'Promote' : 'Save'}
                </Button>
              ) : null}
              {!isPromoting ? (
                <Button variant="outline" onClick={handleDemote} disabled={saving} className="text-destructive hover:text-destructive">
                  {isRepoSourced ? 'Deactivate repository Project Agent' : 'Demote'}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={handleRequestClose} disabled={saving}>
                {isRepoSourced ? 'Close' : 'Cancel'}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <DiscardChangesDialog
        open={showDiscardDialog}
        onDiscard={handleConfirmDiscard}
        onCancel={handleCancelDiscard}
      />
    </>
  )
}
