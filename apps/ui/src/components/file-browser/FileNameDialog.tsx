import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

interface FileNameDialogProps {
  open: boolean
  mode: 'create' | 'rename'
  initialValue?: string
  directoryPath?: string
  entryType?: 'file' | 'directory'
  errorMessage?: string | null
  isSubmitting?: boolean
  onSubmit: (name: string) => void
  onClose: () => void
}

export function FileNameDialog({
  open,
  mode,
  initialValue = '',
  directoryPath = '',
  entryType = 'file',
  errorMessage = null,
  isSubmitting = false,
  onSubmit,
  onClose,
}: FileNameDialogProps) {
  const [draft, setDraft] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setDraft(initialValue)
    const handle = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(handle)
  }, [initialValue, open])

  const title = mode === 'create'
    ? 'New file'
    : `Rename ${entryType === 'directory' ? 'folder' : 'file'}`
  const description = mode === 'create'
    ? directoryPath
      ? `Create a new file in ${directoryPath}.`
      : 'Create a new file in the workspace root.'
    : 'Enter a new name. Use a file or folder name only, not a path.'
  const label = mode === 'create' ? 'File name' : 'New name'
  const submitLabel = mode === 'create' ? 'Create file' : 'Rename'

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting || draft.length === 0) return
    onSubmit(draft)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !isSubmitting) onClose() }}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-2">
            <Label htmlFor="file-name-dialog-input">{label}</Label>
            <Input
              ref={inputRef}
              id="file-name-dialog-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={isSubmitting}
              aria-invalid={Boolean(errorMessage)}
              aria-describedby={errorMessage ? 'file-name-dialog-error' : undefined}
            />
            {errorMessage ? (
              <p id="file-name-dialog-error" role="alert" className="text-xs text-destructive">
                {errorMessage}
              </p>
            ) : null}
          </div>

          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || draft.length === 0}>
              {isSubmitting ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
