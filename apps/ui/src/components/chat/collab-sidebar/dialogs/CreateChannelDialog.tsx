import { useEffect, useMemo, useState, type FormEvent } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { createChannel } from '@/lib/collaboration-api'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'

const NO_CATEGORY_VALUE = '__none__'

interface CreateChannelDialogProps {
  open: boolean
  categories: CollaborationCategory[]
  defaultCategoryId?: string
  onClose: () => void
  onCreated?: (channel: CollaborationChannel) => void
}

export function CreateChannelDialog({
  open,
  categories,
  defaultCategoryId,
  onClose,
  onCreated,
}: CreateChannelDialogProps) {
  const [name, setName] = useState('')
  const [categoryValue, setCategoryValue] = useState(defaultCategoryId ?? NO_CATEGORY_VALUE)
  const [description, setDescription] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setCategoryValue(defaultCategoryId ?? NO_CATEGORY_VALUE)
  }, [defaultCategoryId, open])

  const sortedCategories = useMemo(
    () => [...categories].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name)),
    [categories],
  )

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isSaving) {
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const channel = await createChannel({
        name: trimmedName,
        categoryId: categoryValue === NO_CATEGORY_VALUE ? undefined : categoryValue,
        description: description.trim() || undefined,
      })
      onCreated?.(channel)
      setName('')
      setCategoryValue(NO_CATEGORY_VALUE)
      setDescription('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create channel')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-w-md p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>New Channel</DialogTitle>
          <DialogDescription>Create a new collaboration channel.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="collab-create-channel-name">Name</Label>
            <Input
              id="collab-create-channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="engineering"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-create-channel-category">Category</Label>
            <Select value={categoryValue} onValueChange={setCategoryValue}>
              <SelectTrigger id="collab-create-channel-category" className="w-full">
                <SelectValue placeholder="No category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY_VALUE}>No category</SelectItem>
                {sortedCategories.map((category) => (
                  <SelectItem key={category.categoryId} value={category.categoryId}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-create-channel-description">Description</Label>
            <Textarea
              id="collab-create-channel-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional topic or purpose"
              className="min-h-24 resize-none"
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSaving}>
              {isSaving ? 'Creating…' : 'Create channel'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
