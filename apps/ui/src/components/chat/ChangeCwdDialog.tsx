import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FolderOpen, Check, Loader2, AlertCircle } from 'lucide-react'
import type { DirectoryValidationResult } from '@/lib/ws-client'

interface ChangeCwdDialogProps {
  profileId: string
  profileLabel: string
  currentCwd: string
  onConfirm: (profileId: string, cwd: string) => Promise<void>
  onClose: () => void
  onBrowseDirectory: (defaultPath: string) => Promise<string | null>
  onValidateDirectory: (path: string) => Promise<DirectoryValidationResult>
}

export function ChangeCwdDialog({
  profileId,
  profileLabel,
  currentCwd,
  onConfirm,
  onClose,
  onBrowseDirectory,
  onValidateDirectory,
}: ChangeCwdDialogProps) {
  const [cwd, setCwd] = useState(currentCwd)
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    message: string | null
    resolvedPath?: string
  } | null>(null)
  const [isPickingDirectory, setIsPickingDirectory] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const validationSeqRef = useRef(0)

  // Debounced validation on cwd change
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    const seq = ++validationSeqRef.current
    const trimmed = cwd.trim()
    if (!trimmed) {
      setValidationResult(null)
      setIsValidating(false)
      return
    }

    if (trimmed === currentCwd) {
      setValidationResult({ valid: true, message: null, resolvedPath: currentCwd })
      setIsValidating(false)
      return
    }

    setIsValidating(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await onValidateDirectory(trimmed)
        if (validationSeqRef.current !== seq) return // stale response — discard
        setValidationResult({
          valid: result.valid,
          message: result.message,
          resolvedPath: result.resolvedPath ?? result.path,
        })
      } catch {
        if (validationSeqRef.current !== seq) return
        setValidationResult({
          valid: false,
          message: 'Failed to validate directory.',
        })
      } finally {
        if (validationSeqRef.current === seq) {
          setIsValidating(false)
        }
      }
    }, 300)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [cwd, currentCwd, onValidateDirectory])

  const handleBrowse = useCallback(async () => {
    setBrowseError(null)
    setIsPickingDirectory(true)

    try {
      const pickedPath = await onBrowseDirectory(cwd.trim() || currentCwd)
      if (pickedPath) {
        validationSeqRef.current += 1
        setCwd(pickedPath)
        // Picked paths are already valid — set immediate validation result
        setValidationResult({ valid: true, message: null, resolvedPath: pickedPath })
      }
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : 'Failed to open folder picker.')
    } finally {
      setIsPickingDirectory(false)
    }
  }, [cwd, currentCwd, onBrowseDirectory])

  const trimmedCwd = cwd.trim()
  const effectiveCwd = validationResult?.valid ? (validationResult.resolvedPath ?? trimmedCwd) : trimmedCwd
  const isUnchanged = !trimmedCwd || effectiveCwd === currentCwd
  const canSubmit = !isUnchanged && !isValidating && !isSubmitting && validationResult?.valid === true

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const resolvedPath = validationResult?.resolvedPath || trimmedCwd
      if (!resolvedPath) return

      setIsSubmitting(true)
      setSubmitError(null)
      try {
        await onConfirm(profileId, resolvedPath)
        onClose()
      } catch (error) {
        setSubmitError(
          error instanceof Error ? error.message : 'Failed to update working directory.',
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [onConfirm, onClose, profileId, trimmedCwd, validationResult],
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isSubmitting) onClose() }}>
      <DialogContent className="max-w-md p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Change Working Directory</DialogTitle>
          <DialogDescription>
            Update the project directory for {profileLabel}. All sessions in this project will use the new path.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="change-cwd-input" className="text-xs font-medium text-muted-foreground">
              Working directory
            </Label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  id="change-cwd-input"
                  placeholder="/path/to/project"
                  value={cwd}
                  onChange={(e) => {
                    setCwd(e.target.value)
                    setBrowseError(null)
                  }}
                  autoFocus
                  className="pr-8"
                />
                {/* Validation status icon */}
                {!isUnchanged && (
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                    {isValidating ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : validationResult?.valid ? (
                      <Check className="size-4 text-green-500" />
                    ) : validationResult && !validationResult.valid ? (
                      <AlertCircle className="size-4 text-destructive" />
                    ) : null}
                  </div>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleBrowse}
                disabled={isPickingDirectory}
                className="shrink-0 gap-1.5"
              >
                <FolderOpen className="size-3.5" />
                {isPickingDirectory ? 'Browsing...' : 'Browse'}
              </Button>
            </div>

            {browseError ? (
              <p className="text-xs text-destructive">{browseError}</p>
            ) : null}

            {submitError ? (
              <p className="text-xs text-destructive">{submitError}</p>
            ) : null}

            {validationResult && !validationResult.valid && validationResult.message ? (
              <p className="text-xs text-destructive">{validationResult.message}</p>
            ) : null}

            {validationResult?.valid && validationResult.resolvedPath && validationResult.resolvedPath !== trimmedCwd ? (
              <p className="text-xs text-muted-foreground">
                Resolved: {validationResult.resolvedPath}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Updating…
                </>
              ) : (
                'Update'
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
