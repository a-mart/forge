import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, UploadCloud } from 'lucide-react'
import type {
  ManagerProfile,
  SkillBundleIssue,
  SkillImportConflictState,
  SkillImportPreviewResponse,
  SkillImportResultResponse,
  SkillImportTarget,
} from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import type { SettingsApiClient } from '../settings-api-client'
import { toErrorMessage } from '../settings-api'
import { importSkill, previewSkillImportFromUrl } from './skills-viewer-api'

const GLOBAL_SCOPE_VALUE = '__global__'

interface SkillImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientOrWsUrl: SettingsApiClient | string
  profiles: ManagerProfile[]
  initialUrl?: string
  initialScope: string
  onImported: (result: SkillImportResultResponse) => void | Promise<void>
}

export function SkillImportDialog({
  open,
  onOpenChange,
  clientOrWsUrl,
  profiles,
  initialUrl,
  initialScope,
  onImported,
}: SkillImportDialogProps) {
  const [url, setUrl] = useState('')
  const [targetScope, setTargetScope] = useState(GLOBAL_SCOPE_VALUE)
  const [preview, setPreview] = useState<SkillImportPreviewResponse | null>(null)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [reviewAccepted, setReviewAccepted] = useState(false)
  const [replaceAccepted, setReplaceAccepted] = useState(false)
  const [lastAutoPreviewUrl, setLastAutoPreviewUrl] = useState<string | null>(null)
  const [previewSource, setPreviewSource] = useState<{ url: string; scope: string } | null>(null)
  const previewRequestIdRef = useRef(0)

  const normalizedInitialScope = useMemo(
    () => (profiles.some((profile) => profile.profileId === initialScope) ? initialScope : GLOBAL_SCOPE_VALUE),
    [initialScope, profiles],
  )

  const invalidatePreview = useCallback((options: { clearError?: boolean } = {}) => {
    previewRequestIdRef.current += 1
    setPreview(null)
    setPreviewSource(null)
    setReviewAccepted(false)
    setReplaceAccepted(false)
    setSuccess(null)
    setIsPreviewing(false)
    if (options.clearError) {
      setError(null)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setPreview(null)
      setError(null)
      setSuccess(null)
      setReviewAccepted(false)
      setReplaceAccepted(false)
      setLastAutoPreviewUrl(null)
      setPreviewSource(null)
      setIsPreviewing(false)
      setIsImporting(false)
      previewRequestIdRef.current += 1
      return
    }
    setTargetScope(normalizedInitialScope)
    if (!initialUrl) {
      setUrl('')
      setLastAutoPreviewUrl(null)
    }
  }, [initialUrl, normalizedInitialScope, open])

  useEffect(() => {
    if (!open || !initialUrl || initialUrl === lastAutoPreviewUrl) return
    setUrl(initialUrl)
    setLastAutoPreviewUrl(initialUrl)
    void handlePreview(initialUrl, normalizedInitialScope)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl, lastAutoPreviewUrl, normalizedInitialScope, open])

  const previewMatchesCurrent = Boolean(preview && previewSource?.url === url.trim() && previewSource.scope === targetScope)
  const hasConflict = Boolean(preview?.conflict.exists)
  const blockingConflict = Boolean(preview?.conflict.isBlocking)
  const canInstall = previewMatchesCurrent && reviewAccepted && !isImporting && !isPreviewing && (!hasConflict || replaceAccepted) && !blockingConflict
  const importButtonLabel = getImportButtonLabel(preview?.conflict)

  const handlePreview = async (overrideUrl?: string, overrideScope?: string) => {
    const nextUrl = (overrideUrl ?? url).trim()
    if (!nextUrl) {
      setError('Paste a Forge skill share URL first.')
      return
    }
    const nextScope = overrideScope ?? targetScope
    const nextTarget = targetFromScope(nextScope)
    const requestId = previewRequestIdRef.current + 1
    previewRequestIdRef.current = requestId
    setError(null)
    setSuccess(null)
    setPreview(null)
    setPreviewSource(null)
    setReviewAccepted(false)
    setReplaceAccepted(false)
    setIsPreviewing(true)
    try {
      const nextPreview = await previewSkillImportFromUrl(clientOrWsUrl, { url: nextUrl, target: nextTarget })
      if (requestId !== previewRequestIdRef.current) {
        return
      }
      setPreview(nextPreview)
      setPreviewSource({ url: nextUrl, scope: nextScope })
    } catch (err) {
      if (requestId !== previewRequestIdRef.current) {
        return
      }
      setError(toErrorMessage(err))
    } finally {
      if (requestId === previewRequestIdRef.current) {
        setIsPreviewing(false)
      }
    }
  }

  const handleUrlChange = (value: string) => {
    setUrl(value)
    if (preview || previewSource || isPreviewing || reviewAccepted || replaceAccepted) {
      invalidatePreview({ clearError: true })
    }
  }

  const handleTargetChange = (value: string) => {
    setTargetScope(value)
    if (url.trim()) {
      void handlePreview(url, value)
      return
    }
    invalidatePreview({ clearError: true })
  }

  const handleImport = async () => {
    if (!preview || !previewSource || !canInstall) return
    setError(null)
    setSuccess(null)
    setIsImporting(true)
    try {
      const result = await importSkill(clientOrWsUrl, {
        source: { url: previewSource.url },
        target: targetFromScope(previewSource.scope),
        ...(hasConflict ? { conflictStrategy: 'replace', confirmReplace: true } : { conflictStrategy: 'reject' }),
      })
      setSuccess(`${result.bundle.skill.name} imported. New sessions and refreshed runtimes will see the skill.`)
      await onImported(result)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0">
        <div className="flex max-h-[85vh] flex-col">
          <div className="border-b border-border p-6 pb-4">
            <DialogHeader>
              <DialogTitle>Import skill from URL</DialogTitle>
              <DialogDescription>
                Paste a Forge skill-share link, review the local preview, then choose whether to install. Opening a link never auto-installs a skill.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="flex flex-col gap-5">
              <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="skill-import-url" className="text-xs">Share URL</Label>
                  <Input
                    id="skill-import-url"
                    value={url}
                    onChange={(event) => handleUrlChange(event.target.value)}
                    placeholder="https://share.forge.dev/s/..."
                    className="font-mono text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Install target</Label>
                  <Select value={targetScope} onValueChange={handleTargetChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Target" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={GLOBAL_SCOPE_VALUE}>Global skills</SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.profileId} value={profile.profileId}>
                          Project: {profile.displayName || profile.profileId}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button onClick={() => void handlePreview()} disabled={isPreviewing || !url.trim()}>
                    {isPreviewing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <UploadCloud className="mr-2 size-4" />}
                    Preview
                  </Button>
                </div>
              </div>

              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  {error}
                </div>
              )}

              {success && (
                <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                  <CheckCircle2 className="mt-0.5 size-4" />
                  <span>{success}</span>
                </div>
              )}

              {preview && (
                <ImportPreview
                  preview={preview}
                  reviewAccepted={reviewAccepted}
                  replaceAccepted={replaceAccepted}
                  onReviewAcceptedChange={setReviewAccepted}
                  onReplaceAcceptedChange={setReplaceAccepted}
                />
              )}
            </div>
          </div>

          <DialogFooter className="border-t border-border p-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={() => void handleImport()} disabled={!canInstall}>
              {isImporting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {importButtonLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ImportPreview({
  preview,
  reviewAccepted,
  replaceAccepted,
  onReviewAcceptedChange,
  onReplaceAcceptedChange,
}: {
  preview: SkillImportPreviewResponse
  reviewAccepted: boolean
  replaceAccepted: boolean
  onReviewAcceptedChange: (checked: boolean) => void
  onReplaceAcceptedChange: (checked: boolean) => void
}) {
  const bundle = preview.bundle
  const targetLabel = preview.target.scope === 'profile' ? `project ${preview.target.profileId}` : 'global skills'
  const scripts = bundle.portability.scripts
  const dependencies = bundle.portability.dependencies
  const env = bundle.skill.env
  const osWarnings = preview.warnings.filter((warning) => warning.code.includes('os') || warning.code.includes('platform'))
  const securityWarnings = preview.warnings.filter((warning) => !osWarnings.includes(warning))

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">{bundle.skill.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">Handle: <code>{bundle.skill.handle}</code></p>
            {bundle.skill.description && <p className="mt-2 text-xs text-muted-foreground">{bundle.skill.description}</p>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{bundle.totals.fileCount} files</Badge>
            <Badge variant="secondary">{formatBytes(bundle.totals.byteCount)}</Badge>
            <Badge variant="secondary">{bundle.origin.platform}/{bundle.origin.arch}</Badge>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Install target: {targetLabel}. Active sessions are not auto-restarted; new sessions and refreshed runtimes pick up imported skills.</p>
      </div>

      {preview.conflict.exists && (
        <ConflictPanel preview={preview} />
      )}

      <WarningSection title="Scripts to review" empty="No script files detected." issues={scripts.map((script) => ({
        code: script.kind,
        path: script.path,
        message: [script.executable ? 'executable' : null, script.shebang].filter(Boolean).join(', ') || 'Script-like file',
      }))} />

      <WarningSection title="Dependencies and installers" empty="No dependency manifests detected." issues={dependencies.flatMap((dependency) => [
        { code: dependency.manager, path: dependency.path, message: dependency.summary },
        ...dependency.warnings.map((warning) => ({ code: 'dependency_warning', path: dependency.path, message: warning })),
      ])} />

      <WarningSection title="Environment variables" empty="No environment variables declared." issues={env.map((entry) => ({
        code: entry.required ? 'required_env' : 'optional_env',
        message: `${entry.name}${entry.description ? ` — ${entry.description}` : ''}`,
      }))} />

      <WarningSection title="OS and platform notes" empty="No OS mismatch warnings." issues={osWarnings} />
      <WarningSection title="Security and portability warnings" empty="No additional warnings." issues={securityWarnings} />

      <Acknowledgement
        checked={reviewAccepted}
        onCheckedChange={onReviewAcceptedChange}
        label="I reviewed the scripts, dependencies, OS notes, environment variables, and warnings for this skill."
      />

      {preview.conflict.exists && !preview.conflict.isBlocking && (
        <Acknowledgement
          checked={replaceAccepted}
          onCheckedChange={onReplaceAcceptedChange}
          label={getConflictAcknowledgementLabel(preview)}
        />
      )}
    </div>
  )
}

function ConflictPanel({ preview }: { preview: SkillImportPreviewResponse }) {
  const conflict = preview.conflict
  const related = conflict.relatedConflicts ?? []
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4" />
        {conflict.isBlocking ? 'Blocking skill conflict' : 'Existing skill conflict'}
      </div>
      <p>{getConflictDescription(preview)}</p>
      {conflict.existingRootPath && <p className="mt-1 break-all opacity-90">{conflict.existingRootPath}</p>}
      {conflict.isBlocking && <p className="mt-2 font-medium">This import would shadow a required built-in skill and cannot be installed.</p>}
      {related.length > 0 && (
        <div className="mt-2 rounded border border-destructive/20 p-2">
          <p className="font-medium">Also detected:</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {related.map((item, index) => (
              <li key={`${item.conflictType}-${item.rootPath ?? index}`}>
                {item.sourceKind ?? 'skill'} {item.directoryName ?? preview.bundle.skill.handle} ({item.conflictType.replace('_', ' ')})
                {item.rootPath ? ` — ${item.rootPath}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function getImportButtonLabel(conflict: SkillImportConflictState | undefined): string {
  if (!conflict?.exists) return 'Import skill'
  if (conflict.conflictType === 'effective_skill') return 'Install override'
  return 'Replace and import'
}

function getConflictAcknowledgementLabel(preview: SkillImportPreviewResponse): string {
  const scopeLabel = getTargetScopeLabel(preview.target)
  const replacesTarget = preview.conflict.conflictType === 'target_path'
  const installsOverride = hasEffectiveSkillConflict(preview.conflict)
  if (replacesTarget && installsOverride) {
    return `I understand this replaces the whole existing ${scopeLabel} skill directory and shadows an inherited skill. It is not a merge.`
  }
  if (replacesTarget) {
    return `I understand this replaces the whole existing ${scopeLabel} skill directory. It is not a merge.`
  }
  return `I understand this installs a ${scopeLabel} override that shadows the inherited skill. The inherited skill directory is not modified.`
}

function getConflictDescription(preview: SkillImportPreviewResponse): string {
  const conflict = preview.conflict
  const sourceKind = conflict.existingSourceKind ?? 'skill'
  const directoryName = conflict.existingDirectoryName ?? preview.bundle.skill.handle
  const scopeLabel = getTargetScopeLabel(preview.target)
  if (conflict.conflictType === 'effective_skill') {
    return `An existing ${sourceKind} skill named ${directoryName} is already effective for this target. Importing will install a ${scopeLabel} override; the existing skill directory will not be modified.`
  }
  if (hasEffectiveSkillConflict(conflict)) {
    return `A ${scopeLabel} skill directory named ${directoryName} already exists at the install target and will be replaced if confirmed. The imported skill will also shadow an inherited skill.`
  }
  return `A ${scopeLabel} skill directory named ${directoryName} already exists at the install target and will be replaced if confirmed.`
}

function hasEffectiveSkillConflict(conflict: SkillImportConflictState): boolean {
  if (conflict.conflictType === 'effective_skill') return true
  return (conflict.relatedConflicts ?? []).some((item) => item.conflictType === 'effective_skill')
}

function getTargetScopeLabel(target: SkillImportTarget): string {
  return target.scope === 'profile' ? 'project' : 'global'
}

function WarningSection({
  title,
  empty,
  issues,
}: {
  title: string
  empty: string
  issues: Array<Pick<SkillBundleIssue, 'code' | 'message' | 'path'>>
}) {
  return (
    <div className="rounded-md border border-border bg-card/20 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <AlertTriangle className="size-4 text-amber-300" />
        {title}
      </div>
      {issues.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.path ?? ''}-${index}`}>
              <span className="font-medium text-foreground">{issue.code}</span>{issue.path ? ` (${issue.path})` : ''}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Acknowledgement({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card/20 p-3 text-xs text-muted-foreground">
      <Checkbox aria-label={label} checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <span>{label}</span>
    </label>
  )
}

function targetFromScope(scope: string): SkillImportTarget {
  if (scope === GLOBAL_SCOPE_VALUE) {
    return { scope: 'global' }
  }
  return { scope: 'profile', profileId: scope }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export { GLOBAL_SCOPE_VALUE as SKILL_IMPORT_GLOBAL_SCOPE_VALUE }
