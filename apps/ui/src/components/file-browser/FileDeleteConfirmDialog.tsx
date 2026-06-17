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
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {isDirectory ? 'folder' : 'file'}</AlertDialogTitle>
          <AlertDialogDescription>
            {isDirectory
              ? `Delete folder "${entryName}" and everything inside it? This permanently removes the folder and its contents. This cannot be undone.`
              : `Delete "${entryName}"? This permanently removes the file. This cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
