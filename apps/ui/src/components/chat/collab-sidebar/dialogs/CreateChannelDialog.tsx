import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
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
import { AI_ROLE_OPTIONS, DEFAULT_AI_ROLE } from '@/lib/collaboration-ai-roles'
import type { CollaborationAiRoleId } from '@/lib/collaboration-ai-roles'
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
  const [aiRoleId, setAiRoleId] = useState<CollaborationAiRoleId>(DEFAULT_AI_ROLE)
  const [description, setDescription] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track whether the user has manually picked a role so category changes
  // stop auto-syncing once the user has made an explicit choice.
  const userOverrodeRole = useRef(false)

  /** Resolve the defaultAiRoleId for a category value. */
  function roleForCategoryWithDefault(catValue: string): CollaborationAiRoleId {
    if (catValue === NO_CATEGORY_VALUE) return DEFAULT_AI_ROLE
    const cat = categories.find((c) => c.categoryId === catValue)
    return cat?.defaultAiRoleId ?? cat?.defaultAiRole ?? DEFAULT_AI_ROLE
  }

  // Sync category selection when the dialog opens with a pre-selected category
  useEffect(() => {
    if (open) {
      const nextCat = defaultCategoryId ?? NO_CATEGORY_VALUE
      setCategoryValue(nextCat)
      setAiRoleId(roleForCategoryWithDefault(nextCat))
      userOverrodeRole.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categories identity is stable within a single open
  }, [open, defaultCategoryId])

  const sortedCategories = useMemo(
    () => [...categories].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name)),
    [categories],
  )

  function handleCategoryChange(nextCat: string) {
    setCategoryValue(nextCat)
    if (!userOverrodeRole.current) {
      setAiRoleId(roleForCategoryWithDefault(nextCat))
    }
  }

  function handleAiRoleChange(value: string) {
    setAiRoleId(value)
    userOverrodeRole.current = true
  }

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
        aiRoleId,
      })
      onCreated?.(channel)
      setName('')
      setCategoryValue(NO_CATEGORY_VALUE)
      setAiRoleId(DEFAULT_AI_ROLE)
      userOverrodeRole.current = false
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
            <Select value={categoryValue} onValueChange={handleCategoryChange}>
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
            <Label htmlFor="collab-create-channel-ai-role">AI Role</Label>
            <Select value={aiRoleId} onValueChange={handleAiRoleChange} disabled={isSaving}>
              <SelectTrigger id="collab-create-channel-ai-role" className="w-full">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {AI_ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {AI_ROLE_OPTIONS.find((option) => option.value === aiRoleId)?.description ?? ''}
            </p>
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
