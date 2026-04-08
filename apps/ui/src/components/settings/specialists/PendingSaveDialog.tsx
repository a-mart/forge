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

export function PendingSaveDialog({
  open,
  isSaving,
  onConfirm,
  onCancel,
  onOpenChange,
}: {
  open: boolean
  isSaving: boolean
  onConfirm: () => void
  onCancel: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save without pinning?</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          Your changes will be saved, but they <strong>will be overwritten</strong> the next time Forge updates its builtin specialists. To keep your customizations permanently, enable <strong>Pin customizations</strong> before saving.
        </DialogDescription>
        <DialogFooter className="gap-2 pt-2">
          <Button variant="outline" onClick={onCancel} disabled={isSaving}>
            Go back
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isSaving}
          >
            {isSaving && <Loader2 className="size-3 animate-spin" />}
            Save anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
