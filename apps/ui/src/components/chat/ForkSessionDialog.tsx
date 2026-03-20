import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ForkSessionDialog({
  onConfirm,
  onClose,
  fromMessageTimestamp,
}: {
  onConfirm: (name?: string) => void
  onClose: () => void
  fromMessageTimestamp?: string
}) {
  const [name, setName] = useState('')

  const trimmedName = name.trim()
  const slugPreview = slugifySessionName(trimmedName)
  const showInvalidSlugWarning = trimmedName.length > 0 && slugPreview.length === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onConfirm(trimmedName.length > 0 ? trimmedName : undefined)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Fork Session</DialogTitle>
          <DialogDescription>
            {fromMessageTimestamp
              ? `Fork conversation from message at ${fromMessageTimestamp}. Messages after this point will not be included.`
              : 'Create a fork of this session.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Session name (optional)"
            autoFocus
          />

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Agent id preview:{' '}
              <span className="font-mono">
                {trimmedName.length === 0 ? '(auto-generated)' : (slugPreview || '(invalid)')}
              </span>
            </p>
            {showInvalidSlugWarning ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                This name has no usable characters for an agent id after slugifying.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              Fork
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
