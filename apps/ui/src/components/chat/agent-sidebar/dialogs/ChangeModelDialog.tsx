import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useModelPresets } from '@/lib/model-preset'
import {
  MANAGER_REASONING_LEVELS,
  getChangeManagerFamilies,
  type ManagerModelPreset,
  type ManagerReasoningLevel,
} from '@forge/protocol'

const STATIC_CHANGE_MODEL_FAMILIES = getChangeManagerFamilies()

const REASONING_LEVEL_LABELS: Record<ManagerReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

export function ChangeModelDialog({
  wsUrl,
  profileId,
  profileLabel,
  currentPreset,
  currentReasoningLevel,
  onConfirm,
  onClose,
}: {
  wsUrl?: string
  profileId: string
  profileLabel: string
  currentPreset: ManagerModelPreset | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  onConfirm: (profileId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => void
  onClose: () => void
}) {
  const modelPresets = useModelPresets(wsUrl, 1)
  const changeModelFamilies = useMemo(() => {
    const presetInfoById = new Map(modelPresets.map((preset) => [preset.presetId, preset]))
    const hasServerFilteredFamilies = modelPresets.length > 0

    return STATIC_CHANGE_MODEL_FAMILIES.flatMap((family) => {
      const preset = presetInfoById.get(family.familyId)
      if (!preset && hasServerFilteredFamilies) {
        return []
      }

      return [{
        familyId: family.familyId,
        displayName: preset?.displayName ?? family.displayName,
      }]
    })
  }, [modelPresets])

  const [model, setModel] = useState<ManagerModelPreset>(currentPreset ?? 'pi-codex')
  const [reasoning, setReasoning] = useState<ManagerReasoningLevel>(currentReasoningLevel ?? 'xhigh')

  useEffect(() => {
    if (changeModelFamilies.some((family) => family.familyId === model)) {
      return
    }

    const fallbackFamilyId = changeModelFamilies[0]?.familyId
    if (fallbackFamilyId) {
      setModel(fallbackFamilyId as ManagerModelPreset)
    }
  }, [changeModelFamilies, model])

  const hasChanges = model !== currentPreset || reasoning !== (currentReasoningLevel ?? 'xhigh')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onConfirm(profileId, model, reasoning)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Change Model</DialogTitle>
          <DialogDescription>
            Update the model and reasoning level for {profileLabel}. Changes take effect on the next session resume or new message.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Model</label>
            <Select
              value={model}
              onValueChange={(value) => setModel(value as ManagerModelPreset)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select model preset" />
              </SelectTrigger>
              <SelectContent>
                {changeModelFamilies.map((family) => (
                  <SelectItem key={family.familyId} value={family.familyId}>
                    {family.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Reasoning Level</label>
            <Select
              value={reasoning}
              onValueChange={(value) => setReasoning(value as ManagerReasoningLevel)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select reasoning level" />
              </SelectTrigger>
              <SelectContent>
                {MANAGER_REASONING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {REASONING_LEVEL_LABELS[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Higher reasoning uses more tokens but improves complex task performance.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges}>
              Update
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
