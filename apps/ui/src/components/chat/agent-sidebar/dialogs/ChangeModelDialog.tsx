import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fetchModelOverrides, type ModelOverridesResponse } from '@/components/settings/models-api'
import {
  MANAGER_REASONING_LEVELS,
  type AgentModelDescriptor,
  type ManagerExactModelSelection,
  type ManagerReasoningLevel,
} from '@forge/protocol'
import {
  buildCurrentModelFallbackRow,
  buildManagerModelRows,
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from '@/lib/manager-model-selection'

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
  currentModel,
  currentReasoningLevel,
  onConfirm,
  onClose,
}: {
  wsUrl?: string
  profileId: string
  profileLabel: string
  currentModel: AgentModelDescriptor | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  onConfirm: (profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onClose: () => void
}) {
  const [overridesData, setOverridesData] = useState<ModelOverridesResponse | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(true)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)

  const loadAvailability = useCallback(() => {
    setAvailabilityLoading(true)
    setAvailabilityError(null)
    void fetchModelOverrides(wsUrl).then((data) => {
      setOverridesData(data)
      setAvailabilityLoading(false)
    }).catch((err) => {
      setAvailabilityError(err instanceof Error ? err.message : 'Failed to load model availability')
      setAvailabilityLoading(false)
    })
  }, [wsUrl])

  useEffect(() => {
    loadAvailability()
  }, [loadAvailability])

  const currentKey = currentModel
    ? encodeManagerModelValue(currentModel.provider, currentModel.modelId)
    : undefined

  const { selectableRows, groups } = useMemo(() => {
    if (!overridesData) {
      return { selectableRows: [], groups: [] }
    }

    const rows = buildManagerModelRows(
      'change',
      overridesData.overrides,
      overridesData.providerAvailability,
    )

    const availableRows = rows.filter((r) => !r.unavailableReason)

    // If the current model is not in the list, inject a fallback row
    const isCurrentInList = !currentKey || availableRows.some((r) => r.key === currentKey)
    const selectableRows = isCurrentInList
      ? availableRows
      : [
          ...(currentModel
            ? [buildCurrentModelFallbackRow(currentModel.provider, currentModel.modelId, currentModel.thinkingLevel)]
            : []),
          ...availableRows,
        ]

    return {
      selectableRows,
      groups: groupManagerModelRows(selectableRows),
    }
  }, [overridesData, currentKey, currentModel])

  const [selectedKey, setSelectedKey] = useState<string>(currentKey ?? '')
  const [reasoning, setReasoning] = useState<ManagerReasoningLevel>(currentReasoningLevel ?? 'xhigh')

  // Update selected key when data loads and current is initially empty
  useEffect(() => {
    if (currentKey && selectableRows.some((r) => r.key === currentKey)) {
      setSelectedKey(currentKey)
    }
  }, [currentKey, selectableRows])

  // Get reasoning levels for selected model
  const selectedRow = selectableRows.find((r) => r.key === selectedKey)
  const availableReasoningLevels = useMemo(
    () => selectedRow?.supportedReasoningLevels ?? [...MANAGER_REASONING_LEVELS],
    [selectedRow?.supportedReasoningLevels],
  )

  // Reset reasoning level if not supported by newly selected model
  useEffect(() => {
    if (!availableReasoningLevels.includes(reasoning)) {
      setReasoning(selectedRow?.defaultReasoningLevel ?? 'high')
    }
  }, [availableReasoningLevels, reasoning, selectedRow?.defaultReasoningLevel])

  const isSelectedUnavailable = !!selectedRow?.unavailableReason
  const hasChanges = selectedKey !== currentKey || reasoning !== (currentReasoningLevel ?? 'xhigh')
  const isSelectorsDisabled = availabilityLoading || !!availabilityError

  const handleModelChange = useCallback((value: string) => {
    setSelectedKey(value)
    // When switching models, set reasoning to the new model's default
    const row = selectableRows.find((r) => r.key === value)
    if (row) {
      setReasoning(row.defaultReasoningLevel)
    }
  }, [selectableRows])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const decoded = decodeManagerModelValue(selectedKey)
    if (decoded) {
      onConfirm(profileId, decoded, reasoning)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Change Default Model</DialogTitle>
          <DialogDescription>
            Update the default model and reasoning level for {profileLabel}. Sessions using the project default will be updated. Sessions with a model override are not affected.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label id="change-model-model-label" className="text-sm font-medium">Model</label>
            <Select
              value={selectedKey}
              onValueChange={handleModelChange}
              disabled={isSelectorsDisabled}
            >
              <SelectTrigger className="w-full" aria-labelledby="change-model-model-label">
                <SelectValue placeholder={availabilityLoading ? 'Loading models...' : 'Select model'} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectGroup key={group.provider}>
                    <SelectLabel className="text-xs text-muted-foreground">{group.providerDisplayName}</SelectLabel>
                    {group.rows.map((row) => (
                      <SelectItem
                        key={row.key}
                        value={row.key}
                        disabled={!!row.unavailableReason}
                      >
                        {row.displayName}{row.unavailableReason ? ' (current)' : ''}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label id="change-model-reasoning-label" className="text-sm font-medium">Reasoning Level</label>
            <Select
              value={reasoning}
              onValueChange={(value) => setReasoning(value as ManagerReasoningLevel)}
              disabled={isSelectedUnavailable || isSelectorsDisabled}
            >
              <SelectTrigger className="w-full" aria-labelledby="change-model-reasoning-label">
                <SelectValue placeholder="Select reasoning level" />
              </SelectTrigger>
              <SelectContent>
                {availableReasoningLevels.map((level) => (
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

          {availabilityError ? (
            <div className="flex items-center gap-2">
              <p className="text-xs text-destructive">Failed to load models.</p>
              <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs text-primary underline-offset-4 hover:underline" onClick={loadAvailability}>
                Retry
              </Button>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges || isSelectedUnavailable || isSelectorsDisabled}>
              Update
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
