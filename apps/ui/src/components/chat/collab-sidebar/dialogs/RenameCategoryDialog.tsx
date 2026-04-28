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
import { AI_ROLE_OPTIONS, aiRoleLabel, DEFAULT_AI_ROLE } from '@/lib/collaboration-ai-roles'
import type { AiRoleOption, CollaborationAiRoleId } from '@/lib/collaboration-ai-roles'
import { fetchAiRoles } from '@/lib/collaboration-ai-roles-api'
import { updateCategory } from '@/lib/collaboration-api'
import { getAvailableChangeManagerFamilies, useModelPresets } from '@/lib/model-preset'
import type { CollaborationCategory } from '@forge/protocol'

const NO_DEFAULT_MODEL_VALUE = '__none__'

interface RenameCategoryDialogProps {
  open: boolean
  category: CollaborationCategory
  onClose: () => void
  onRenamed?: (category: CollaborationCategory) => void
  wsUrl?: string
}

export function RenameCategoryDialog({
  open,
  category,
  onClose,
  onRenamed,
  wsUrl,
}: RenameCategoryDialogProps) {
  const [name, setName] = useState(category.name)
  const categoryAiRoleId: CollaborationAiRoleId = category.defaultAiRoleId ?? category.defaultAiRole ?? DEFAULT_AI_ROLE
  const [defaultAiRoleId, setDefaultAiRoleId] = useState<CollaborationAiRoleId>(categoryAiRoleId)
  const [defaultModelId, setDefaultModelId] = useState(category.defaultModelId ?? NO_DEFAULT_MODEL_VALUE)
  const [roleOptions, setRoleOptions] = useState<AiRoleOption[]>([...AI_ROLE_OPTIONS])
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch the full role library (builtins + custom) when the dialog opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchAiRoles()
      .then((data) => {
        if (cancelled) return
        setRoleOptions(
          data.roles.map((r) => ({
            value: r.roleId,
            label: r.name,
            description: r.description ?? '',
          })),
        )
      })
      .catch(() => {
        /* Keep static builtins as fallback */
      })
    return () => {
      cancelled = true
    }
  }, [open])
  const modelPresets = useModelPresets(wsUrl, open ? 1 : 0)
  const modelFamilies = useMemo(() => getAvailableChangeManagerFamilies(modelPresets), [modelPresets])

  useEffect(() => {
    setName(category.name)
    setDefaultAiRoleId(category.defaultAiRoleId ?? category.defaultAiRole ?? DEFAULT_AI_ROLE)
    setDefaultModelId(category.defaultModelId ?? NO_DEFAULT_MODEL_VALUE)
    setError(null)
  }, [category])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isSaving) {
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const updated = await updateCategory(category.categoryId, {
        name: trimmedName,
        defaultAiRoleId,
        defaultModelId: defaultModelId === NO_DEFAULT_MODEL_VALUE ? null : defaultModelId,
      })
      onRenamed?.(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename category')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Category settings</DialogTitle>
          <DialogDescription>Update the category name, default AI role, and default model.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="collab-rename-category-name">Name</Label>
            <Input
              id="collab-rename-category-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-rename-category-default-ai-role">Default AI role</Label>
            <Select
              value={defaultAiRoleId}
              onValueChange={(value) => { if (value) setDefaultAiRoleId(value) }}
              disabled={isSaving}
            >
              <SelectTrigger id="collab-rename-category-default-ai-role" className="w-full">
                <SelectValue placeholder="Select role">
                  {roleOptions.find((o) => o.value === defaultAiRoleId)?.label ?? aiRoleLabel(defaultAiRoleId)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Changes affect new channels only. Existing channels keep their current role.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="collab-rename-category-default-model">Default model</Label>
            <Select value={defaultModelId} onValueChange={setDefaultModelId} disabled={isSaving}>
              <SelectTrigger id="collab-rename-category-default-model" className="w-full">
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
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
