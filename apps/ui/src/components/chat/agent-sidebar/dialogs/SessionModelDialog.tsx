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
  type AgentModelDescriptor,
  type AgentModelOrigin,
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

export function SessionModelDialog({
  wsUrl,
  sessionAgentId,
  sessionLabel,
  currentPreset,
  currentReasoningLevel,
  modelOrigin,
  profileDefaultModel,
  onConfirm,
  onClose,
}: {
  wsUrl?: string
  sessionAgentId: string
  sessionLabel: string
  currentPreset: ManagerModelPreset | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  modelOrigin: AgentModelOrigin | undefined
  profileDefaultModel: AgentModelDescriptor | undefined
  onConfirm: (
    sessionAgentId: string,
    mode: 'inherit' | 'override',
    model?: ManagerModelPreset,
    reasoningLevel?: ManagerReasoningLevel,
  ) => void
  onClose: () => void
}) {
  const isCurrentlyOverridden = modelOrigin === 'session_override'
  const [mode, setMode] = useState<'inherit' | 'override'>(
    isCurrentlyOverridden ? 'override' : 'inherit',
  )
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

  // Determine whether the dialog state differs from the session's persisted state.
  // inherit mode is a change only if the session is currently overridden.
  // override mode is a change if the session is currently inherited (mode switch)
  // or if the model/reasoning differ from the current values.
  const hasChanges =
    mode === 'inherit'
      ? isCurrentlyOverridden
      : !isCurrentlyOverridden || model !== currentPreset || reasoning !== (currentReasoningLevel ?? 'xhigh')

  const profileDefaultLabel = profileDefaultModel
    ? `${profileDefaultModel.provider}/${profileDefaultModel.modelId}${profileDefaultModel.thinkingLevel ? ` (${profileDefaultModel.thinkingLevel})` : ''}`
    : 'unknown'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'inherit') {
      onConfirm(sessionAgentId, 'inherit')
    } else {
      onConfirm(sessionAgentId, 'override', model, reasoning)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Session Model</DialogTitle>
          <DialogDescription>
            Configure the model for {sessionLabel}. Override with a specific model, or inherit the project default.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label id="session-model-mode-label" className="text-sm font-medium">Mode</label>
            <Select value={mode} onValueChange={(value) => setMode(value as 'inherit' | 'override')}>
              <SelectTrigger className="w-full" aria-labelledby="session-model-mode-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Use Project Default</SelectItem>
                <SelectItem value="override">Override</SelectItem>
              </SelectContent>
            </Select>
            {mode === 'inherit' ? (
              <p className="text-xs text-muted-foreground">
                This session will use the project default model ({profileDefaultLabel}) and track future default changes.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                This session will use its own model, independent of the project default.
              </p>
            )}
          </div>

          {mode === 'override' ? (
            <>
              <div className="space-y-2">
                <label id="session-model-model-label" className="text-sm font-medium">Model</label>
                <Select
                  value={model}
                  onValueChange={(value) => setModel(value as ManagerModelPreset)}
                >
                  <SelectTrigger className="w-full" aria-labelledby="session-model-model-label">
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
                <label id="session-model-reasoning-label" className="text-sm font-medium">Reasoning Level</label>
                <Select
                  value={reasoning}
                  onValueChange={(value) => setReasoning(value as ManagerReasoningLevel)}
                >
                  <SelectTrigger className="w-full" aria-labelledby="session-model-reasoning-label">
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
            </>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges}>
              {mode === 'inherit' ? 'Use Project Default' : 'Override'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
