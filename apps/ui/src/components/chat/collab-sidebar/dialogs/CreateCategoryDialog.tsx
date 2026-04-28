import { useMemo, useState, type FormEvent } from 'react'
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
import { AI_ROLE_OPTIONS, DEFAULT_AI_ROLE } from '@/lib/collaboration-ai-roles'
import type { CollaborationAiRoleId } from '@/lib/collaboration-ai-roles'
import { createCategory } from '@/lib/collaboration-api'
import { getAvailableChangeManagerFamilies, useModelPresets } from '@/lib/model-preset'
import type { CollaborationCategory } from '@forge/protocol'

const NO_DEFAULT_MODEL_VALUE = '__none__'

interface CreateCategoryDialogProps {
  open: boolean
  onClose: () => void
  onCreated?: (category: CollaborationCategory) => void
  wsUrl?: string
}

export function CreateCategoryDialog({
  open,
  onClose,
  onCreated,
  wsUrl,
}: CreateCategoryDialogProps) {
  const [name, setName] = useState('')
  const [defaultAiRoleId, setDefaultAiRoleId] = useState<CollaborationAiRoleId>(DEFAULT_AI_ROLE)
  const [defaultModelId, setDefaultModelId] = useState(NO_DEFAULT_MODEL_VALUE)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelPresets = useModelPresets(wsUrl, open ? 1 : 0)
  const modelFamilies = useMemo(() => getAvailableChangeManagerFamilies(modelPresets), [modelPresets])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isSaving) {
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const category = await createCategory({
        name: trimmedName,
        defaultAiRoleId,
        ...(defaultModelId !== NO_DEFAULT_MODEL_VALUE ? { defaultModelId } : {}),
      })
      onCreated?.(category)
      setName('')
      setDefaultAiRoleId(DEFAULT_AI_ROLE)
      setDefaultModelId(NO_DEFAULT_MODEL_VALUE)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create category')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>New Category</DialogTitle>
          <DialogDescription>Create a new sidebar category.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="collab-create-category-name">Name</Label>
            <Input
              id="collab-create-category-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Planning"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-create-category-default-ai-role">Default AI role</Label>
            <Select
              value={defaultAiRoleId}
              onValueChange={(value) => setDefaultAiRoleId(value)}
              disabled={isSaving}
            >
              <SelectTrigger id="collab-create-category-default-ai-role" className="w-full">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {AI_ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              New channels in this category start with this role.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-create-category-default-model">Default model</Label>
            <Select value={defaultModelId} onValueChange={setDefaultModelId} disabled={isSaving}>
              <SelectTrigger id="collab-create-category-default-model" className="w-full">
                <SelectValue placeholder="No default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEFAULT_MODEL_VALUE}>No default</SelectItem>
                {modelFamilies.map((family) => (
                  <SelectItem key={family.familyId} value={family.familyId}>{family.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              New channels in this category start with this model.
            </p>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSaving}>
              {isSaving ? 'Creating…' : 'Create category'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
