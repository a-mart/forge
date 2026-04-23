import { useState } from 'react'
import { archiveChannel } from '@/lib/collaboration-api'
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
import type { CollaborationChannel } from '@forge/protocol'

interface ArchiveChannelDialogProps {
  open: boolean
  channel: CollaborationChannel
  onClose: () => void
  onArchived?: (channelId: string) => void
}

export function ArchiveChannelDialog({
  open,
  channel,
  onClose,
  onArchived,
}: ArchiveChannelDialogProps) {
  const [isArchiving, setIsArchiving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleArchive = async () => {
    if (isArchiving) {
      return
    }

    setIsArchiving(true)
    setError(null)
    try {
      await archiveChannel(channel.channelId)
      onArchived?.(channel.channelId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive channel')
    } finally {
      setIsArchiving(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive Channel</AlertDialogTitle>
          <AlertDialogDescription>
            Archive #{channel.name}? Messages stay intact, but the channel will be removed from the active sidebar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isArchiving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault()
              void handleArchive()
            }}
            disabled={isArchiving}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isArchiving ? 'Archiving…' : 'Archive channel'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
