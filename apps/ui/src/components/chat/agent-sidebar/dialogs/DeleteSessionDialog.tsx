import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function DeleteSessionDialog({
  agentId,
  sessionLabel,
  onConfirm,
  onClose,
}: {
  agentId: string
  sessionLabel: string
  onConfirm: (agentId: string) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Delete Session</DialogTitle>
          <DialogDescription>
            Delete &ldquo;{sessionLabel}&rdquo;? This will permanently remove the session history and memory. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(agentId)}
          >
            Delete session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
