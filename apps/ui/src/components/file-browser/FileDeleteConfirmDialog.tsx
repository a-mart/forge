import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface FileDeleteConfirmDialogProps {
  open: boolean
  entryName: string
  entryType: 'file' | 'directory'
  onConfirm: () => void
  onClose: () => void
}

export function FileDeleteConfirmDialog({
  open,
  entryName,
  entryType,
  onConfirm,
  onClose,
}: FileDeleteConfirmDialogProps) {
  const isDirectory = entryType === 'directory'

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Delete {isDirectory ? 'folder' : 'file'}</DialogTitle>
          <DialogDescription>
            {isDirectory
              ? `Delete folder "${entryName}" and everything inside it? This permanently removes the folder and its contents. This cannot be undone.`
              : `Delete "${entryName}"? This permanently removes the file. This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            Delete permanently
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
