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
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  MANAGER_REASONING_LEVELS,
  type AgentModelDescriptor,
  type ManagerExactModelSelection,
  type ManagerReasoningLevel,
} from '@forge/protocol'
import {
  decodeManagerModelValue,
  encodeManagerModelValue,
  groupManagerModelRows,
} from '@/lib/manager-model-selection'
import {
  buildCatalogCurrentModelFallbackRow,
  projectSelectableManagerModelRows,
} from '@/lib/manager-selection-catalog'
import { useManagerSelectionCatalog } from '@/lib/use-manager-selection-catalog'
import { LOCAL_ORIGIN_ID } from '@/lib/origin-store'
import { formatManagerReasoningLevel } from '@/lib/reasoning-level-labels'

export function ChangeModelDialog({
  wsUrl,
  apiClient,
  originId = LOCAL_ORIGIN_ID,
  modelConfigChangeKey,
  connectionEpoch,
  profileId,
  profileLabel,
  currentModel,
  currentReasoningLevel,
  onConfirm,
  onClose,
}: {
  wsUrl?: string
  apiClient?: SettingsApiClient
  originId?: string
  modelConfigChangeKey?: number
  connectionEpoch?: number
  profileId: string
  profileLabel: string
  currentModel: AgentModelDescriptor | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  onConfirm: (profileId: string, modelSelection: ManagerExactModelSelection, reasoningLevel?: ManagerReasoningLevel) => void
  onClose: () => void
}) {
  const {
    catalog,
    loading: availabilityLoading,
    error: availabilityError,
    refetch: loadAvailability,
  } = useManagerSelectionCatalog({
    originId,
    client: apiClient ?? wsUrl,
    modelConfigChangeKey,
    connectionEpoch,
    forceOnEnabled: true,
  })

  const currentKey = currentModel
    ? encodeManagerModelValue(currentModel.provider, currentModel.modelId)
    : undefined

  const { selectableRows, groups } = useMemo(() => {
    if (!catalog) {
      return { selectableRows: [], groups: [] }
    }

    const availableRows = projectSelectableManagerModelRows(catalog, 'change')

    // If the current model is not in the list, inject a fallback row
    const isCurrentInList = !currentKey || availableRows.some((r) => r.key === currentKey)
    const selectableRows = isCurrentInList
      ? availableRows
      : [
          ...(currentModel
            ? [buildCatalogCurrentModelFallbackRow(
                catalog,
                currentModel.provider,
                currentModel.modelId,
                currentModel.thinkingLevel,
              )]
            : []),
          ...availableRows,
        ]

    return {
      selectableRows,
      groups: groupManagerModelRows(selectableRows),
    }
  }, [catalog, currentKey, currentModel])

  const [selectedKey, setSelectedKey] = useState<string>(currentKey ?? '')
  const [reasoning, setReasoning] = useState<ManagerReasoningLevel>(currentReasoningLevel ?? 'xhigh')

  // The descriptor snapshot remains authoritative while the dialog is open.
  useEffect(() => {
    setSelectedKey(currentKey ?? '')
    setReasoning(currentReasoningLevel ?? 'xhigh')
  }, [currentKey, currentReasoningLevel, profileId])

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
                    {formatManagerReasoningLevel(level, availableReasoningLevels)}
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
              <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-xs text-primary underline-offset-4 hover:underline" onClick={() => loadAvailability(true)}>
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
