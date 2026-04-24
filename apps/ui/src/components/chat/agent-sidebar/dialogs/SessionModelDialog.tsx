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
import { Separator } from '@/components/ui/separator'
import { fetchModelOverrides, type ModelOverridesResponse } from '@/components/settings/models-api'
import {
  MANAGER_REASONING_LEVELS,
  type AgentModelDescriptor,
  type AgentModelOrigin,
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

export function SessionModelDialog({
  wsUrl,
  sessionAgentId,
  sessionLabel,
  currentModel,
  currentReasoningLevel,
  modelOrigin,
  profileDefaultModel,
  onConfirm,
  onClose,
}: {
  wsUrl?: string
  sessionAgentId: string
  sessionLabel: string
  currentModel: AgentModelDescriptor | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  modelOrigin: AgentModelOrigin | undefined
  profileDefaultModel: AgentModelDescriptor | undefined
  onConfirm: (
    sessionAgentId: string,
    mode: 'inherit' | 'override',
    modelSelection?: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => void
  onClose: () => void
}) {
  const isCurrentlyOverridden = modelOrigin === 'session_override'
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

  // Build the selectable model list. If the session's current model is hidden from the
  // change-manager list, inject it as a disabled "current" entry so the dialog never
  // silently switches the model.
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

  // Update selected key when data loads
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
  const isSelectorsDisabled = availabilityLoading || !!availabilityError

  // Change detection: has the user modified model or reasoning from the current effective values?
  const hasChanges =
    selectedKey !== (currentKey ?? '') ||
    reasoning !== (currentReasoningLevel ?? 'xhigh')

  const profileDefaultLabel = profileDefaultModel
    ? `${profileDefaultModel.provider}/${profileDefaultModel.modelId}${profileDefaultModel.thinkingLevel ? ` (${profileDefaultModel.thinkingLevel})` : ''}`
    : 'unknown'

  const handleModelChange = useCallback((value: string) => {
    setSelectedKey(value)
    const row = selectableRows.find((r) => r.key === value)
    if (row) {
      setReasoning(row.defaultReasoningLevel)
    }
  }, [selectableRows])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const decoded = decodeManagerModelValue(selectedKey)
    if (decoded) {
      onConfirm(sessionAgentId, 'override', decoded, reasoning)
    }
  }

  const handleResetToDefault = () => {
    onConfirm(sessionAgentId, 'inherit')
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Session Model</DialogTitle>
          <DialogDescription>
            {isCurrentlyOverridden
              ? `${sessionLabel} uses a custom model override, independent of the project default.`
              : `${sessionLabel} uses the project default model and tracks future changes.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label id="session-model-model-label" className="text-sm font-medium">Model</label>
            <Select
              value={selectedKey}
              onValueChange={handleModelChange}
              disabled={isSelectorsDisabled}
            >
              <SelectTrigger className="w-full" aria-labelledby="session-model-model-label">
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
            <label id="session-model-reasoning-label" className="text-sm font-medium">Reasoning Level</label>
            <Select
              value={reasoning}
              onValueChange={(value) => setReasoning(value as ManagerReasoningLevel)}
              disabled={isSelectedUnavailable || isSelectorsDisabled}
            >
              <SelectTrigger className="w-full" aria-labelledby="session-model-reasoning-label">
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

          <Separator />

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground min-w-0">
              Project default: {profileDefaultLabel}
            </p>
            {isCurrentlyOverridden ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto shrink-0 px-1 py-0 text-xs text-primary underline-offset-4 hover:underline"
                onClick={handleResetToDefault}
              >
                Use Project Default
              </Button>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges || isSelectedUnavailable || isSelectorsDisabled}>
              {isCurrentlyOverridden ? 'Save' : 'Override'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
