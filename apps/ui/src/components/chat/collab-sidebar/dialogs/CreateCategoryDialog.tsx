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
import { createCategory } from '@/lib/collaboration-api'
import { getAvailableChangeManagerFamilies, useModelPresets } from '@/lib/model-preset'
import { REASONING_LEVEL_LABELS } from '@/components/settings/specialists/types'
import type { CollaborationCategory, ManagerReasoningLevel, ModelPresetInfo } from '@forge/protocol'

const NO_DEFAULT_MODEL_VALUE = '__none__'
const NO_REASONING_LEVEL_VALUE = '__none__'

interface CreateCategoryDialogProps {
  open: boolean
  onClose: () => void
  onCreated?: (category: CollaborationCategory) => void
  wsUrl?: string
}

/** Resolve the preset info for a given family/preset ID. */
function findPreset(modelPresets: ModelPresetInfo[], familyId: string): ModelPresetInfo | undefined {
  return modelPresets.find((preset) => preset.presetId === familyId)
}

/** Get supported reasoning levels for the selected model family. */
function getSupportedLevelsForFamily(
  modelPresets: ModelPresetInfo[],
  familyId: string,
): ManagerReasoningLevel[] {
  const preset = findPreset(modelPresets, familyId)
  return preset?.supportedReasoningLevels ?? []
}

export function CreateCategoryDialog({
  open,
  onClose,
  onCreated,
  wsUrl,
}: CreateCategoryDialogProps) {
  const [name, setName] = useState('')
  const [defaultModelId, setDefaultModelId] = useState(NO_DEFAULT_MODEL_VALUE)
  const [reasoningLevel, setReasoningLevel] = useState(NO_REASONING_LEVEL_VALUE)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelPresets = useModelPresets(wsUrl, open ? 1 : 0)
  const modelFamilies = useMemo(() => getAvailableChangeManagerFamilies(modelPresets), [modelPresets])

  const supportedLevels = useMemo(
    () => defaultModelId !== NO_DEFAULT_MODEL_VALUE
      ? getSupportedLevelsForFamily(modelPresets, defaultModelId)
      : [],
    [modelPresets, defaultModelId],
  )

  useEffect(() => {
    if (!open) return
    setName('')
    setDefaultModelId(NO_DEFAULT_MODEL_VALUE)
    setReasoningLevel(NO_REASONING_LEVEL_VALUE)
    setError(null)
  }, [open])

  // Reset reasoning level when model changes
  useEffect(() => {
    if (defaultModelId === NO_DEFAULT_MODEL_VALUE) {
      setReasoningLevel(NO_REASONING_LEVEL_VALUE)
      return
    }
    const preset = findPreset(modelPresets, defaultModelId)
    if (preset) {
      setReasoningLevel(preset.defaultReasoningLevel)
    }
  }, [defaultModelId, modelPresets])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || isSaving) {
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      const hasModel = defaultModelId !== NO_DEFAULT_MODEL_VALUE
      const preset = hasModel ? findPreset(modelPresets, defaultModelId) : undefined

      const category = await createCategory({
        name: trimmedName,
        ...(hasModel && preset
          ? {
              channelCreationDefaults: {
                model: {
                  provider: preset.provider,
                  modelId: preset.modelId,
                  thinkingLevel: reasoningLevel !== NO_REASONING_LEVEL_VALUE
                    ? reasoningLevel
                    : preset.defaultReasoningLevel,
                },
              },
              defaultModelId: defaultModelId,
            }
          : hasModel
            ? { defaultModelId }
            : {}),
      })
      onCreated?.(category)
      setName('')
      setDefaultModelId(NO_DEFAULT_MODEL_VALUE)
      setReasoningLevel(NO_REASONING_LEVEL_VALUE)
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
            <Label htmlFor="collab-create-category-default-model">Default model</Label>
            <div className="flex gap-2">
              <Select value={defaultModelId} onValueChange={setDefaultModelId} disabled={isSaving}>
                <SelectTrigger id="collab-create-category-default-model" className="flex-1">
                  <SelectValue placeholder="No default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEFAULT_MODEL_VALUE}>No default</SelectItem>
                  {modelFamilies.map((family) => (
                    <SelectItem key={family.familyId} value={family.familyId}>{family.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {defaultModelId !== NO_DEFAULT_MODEL_VALUE && supportedLevels.length > 0 ? (
                <Select value={reasoningLevel} onValueChange={setReasoningLevel} disabled={isSaving}>
                  <SelectTrigger
                    id="collab-create-category-reasoning-level"
                    className="w-28 shrink-0"
                  >
                    <SelectValue placeholder="Reasoning" />
                  </SelectTrigger>
                  <SelectContent>
                    {supportedLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {REASONING_LEVEL_LABELS[level] || level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
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
