import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
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
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  MANAGER_REASONING_LEVELS,
  type AgentModelDescriptor,
  type AgentModelOrigin,
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

export function SessionModelDialog({
  apiClient,
  wsUrl,
  originId = LOCAL_ORIGIN_ID,
  modelConfigChangeKey,
  connectionEpoch,
  sessionAgentId,
  sessionLabel,
  currentModel,
  currentReasoningLevel,
  modelOrigin,
  profileDefaultModel,
  onConfirm,
  onClose,
  returnFocusRef,
}: {
  /** Target-aware origin client. New call sites should prefer this over wsUrl. */
  apiClient?: SettingsApiClient
  /** Legacy local-sidebar compatibility path. */
  wsUrl?: string
  originId?: string
  modelConfigChangeKey?: number
  connectionEpoch?: number
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
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const isCurrentlyOverridden = modelOrigin === 'session_override'
  const canUseProjectDefault = isCurrentlyOverridden || Boolean(profileDefaultModel && (
    currentModel?.provider !== profileDefaultModel.provider ||
    currentModel?.modelId !== profileDefaultModel.modelId ||
    currentModel?.thinkingLevel !== profileDefaultModel.thinkingLevel
  ))
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

  // Build the selectable model list. If the session's current model is hidden from the
  // change-manager list, inject it as a disabled "current" entry so the dialog never
  // silently switches the model.
  const { selectableRows, groups } = useMemo(() => {
    if (!catalog) {
      return { selectableRows: [], groups: [] }
    }

    const availableRows = projectSelectableManagerModelRows(catalog, 'change')
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

  // Snapshot updates are authoritative. Reset any in-progress selection when the
  // effective model/reasoning changes so stale dialog state can never be saved.
  useEffect(() => {
    setSelectedKey(currentKey ?? '')
    setReasoning(currentReasoningLevel ?? 'xhigh')
  }, [currentKey, currentReasoningLevel, sessionAgentId])

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
    e.stopPropagation()
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
      <DialogContent
        className="max-w-sm p-4"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return
          event.preventDefault()
          returnFocusRef.current.focus()
        }}
      >
        <DialogHeader className="mb-3">
          <DialogTitle>Session Model</DialogTitle>
          <DialogDescription>
            {isCurrentlyOverridden
              ? `${sessionLabel} uses a custom model override, independent of the project default.`
              : `${sessionLabel} uses a model selected from the project default. Future default changes apply only to new conversations.`}
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

          <Separator />

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground min-w-0">
              Project default: {profileDefaultLabel}
            </p>
            {canUseProjectDefault ? (
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
