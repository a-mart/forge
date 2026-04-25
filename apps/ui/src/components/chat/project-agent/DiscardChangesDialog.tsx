import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

export function DiscardChangesDialog({
  open,
  onDiscard,
  onCancel,
}: {
  open: boolean
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription>
          You have unsaved changes that will be lost if you close this panel.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            Discard
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
