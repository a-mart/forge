import { useEffect, useState, type FormEvent } from 'react'
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
import { updateChannel } from '@/lib/collaboration-api'
import type { CollaborationChannel } from '@forge/protocol'

interface RenameChannelDialogProps {
  open: boolean
  channel: CollaborationChannel
  onClose: () => void
  onRenamed?: (channel: CollaborationChannel) => void
}

export function RenameChannelDialog({
  open,
  channel,
  onClose,
  onRenamed,
}: RenameChannelDialogProps) {
  const [name, setName] = useState(channel.name)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(channel.name)
    setError(null)
  }, [channel])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isSaving) {
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const updated = await updateChannel(channel.channelId, { name: trimmedName })
      onRenamed?.(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename channel')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Rename Channel</DialogTitle>
          <DialogDescription>Update the channel name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="collab-rename-channel-name">Name</Label>
            <Input
              id="collab-rename-channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSaving}>
              {isSaving ? 'Saving…' : 'Rename'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
