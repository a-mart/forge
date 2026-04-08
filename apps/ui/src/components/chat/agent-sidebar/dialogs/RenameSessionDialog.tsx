import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function RenameSessionDialog({
  agentId,
  currentLabel,
  onConfirm,
  onClose,
}: {
  agentId: string
  currentLabel: string
  onConfirm: (agentId: string, label: string) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(currentLabel)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = label.trim()
    if (trimmed) {
      onConfirm(agentId, trimmed)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Rename Session</DialogTitle>
          <DialogDescription>Enter a new label for this session.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Session name"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!label.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
