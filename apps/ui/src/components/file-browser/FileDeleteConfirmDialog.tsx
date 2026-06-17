import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

interface FileDeleteConfirmDialogProps {
  open: boolean
  entryName: string
  entryType: 'file' | 'directory'
  errorMessage?: string | null
  isDeleting?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function FileDeleteConfirmDialog({
  open,
  entryName,
  entryType,
  errorMessage = null,
  isDeleting = false,
  onConfirm,
  onClose,
}: FileDeleteConfirmDialogProps) {
  const isDirectory = entryType === 'directory'
  const deleteLabel = isDeleting ? 'Deleting…' : 'Delete permanently'

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {isDirectory ? 'folder' : 'file'}</AlertDialogTitle>
          <AlertDialogDescription>
            {isDirectory
              ? `Delete folder "${entryName}" and everything inside it? This permanently removes the folder and its contents. This cannot be undone.`
              : `Delete "${entryName}"? This permanently removes the file. This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {errorMessage ? (
          <div
            role="alert"
            className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-medium">Delete failed</p>
              <p className="break-words leading-relaxed">{errorMessage}</p>
            </div>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button type="button" variant="outline" disabled={isDeleting} onClick={onClose}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              aria-label={deleteLabel}
              onClick={(event) => {
                event.preventDefault()
                onConfirm()
              }}
            >
              {isDeleting ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" /> : null}
              {deleteLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
