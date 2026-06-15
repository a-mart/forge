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
import type { FileDirtyConfirmDialogState } from './use-file-editor-coordinator'

interface FileDirtyConfirmDialogProps {
  state: FileDirtyConfirmDialogState
}

export function FileDirtyConfirmDialog({ state }: FileDirtyConfirmDialogProps) {
  const fileName = state.snapshot?.fileName ?? 'this file'

  return (
    <AlertDialog open={state.open} onOpenChange={(open) => {
      if (!open && !state.isSaving) {
        state.onCancel()
      }
    }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to this file?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes in {fileName}. Save before continuing, discard them, or cancel.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={state.isSaving} onClick={state.onCancel}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={state.isSaving}
            onClick={state.onDiscard}
          >
            Discard
          </Button>
          <AlertDialogAction disabled={state.isSaving} onClick={(event) => {
            event.preventDefault()
            state.onSave()
          }}>
            {state.isSaving ? 'Saving…' : 'Save'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
