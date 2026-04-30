import { useCallback, useState } from 'react'
import type { ManagerReasoningLevel, ModelPresetInfo, ResolvedSpecialistDefinition } from '@forge/protocol'
import { getSupportedReasoningLevelsForModelId } from '@/lib/model-preset'
import type { SettingsApiClient } from '../../settings-api-client'
import type { CardEditState } from '../types'
import {
  specialistToEditState,
  toSaveSpecialistPayload,
  normalizeHandle,
  generateUniqueCloneHandle,
  pickAvailableColor,
  modelSupportsWebSearch,
} from '../utils'
import {
  saveSpecialist,
  saveSharedSpecialist,
  deleteSpecialist,
  deleteSharedSpecialist as deleteSharedSpecialistApi,
  saveChannelSpecialist,
  deleteChannelSpecialistApi,
  type SaveSpecialistPayload,
} from '../../specialists-api'

/**
 * Manages per-card editing state, save/delete/clone/revert actions,
 * and prompt/fallback expansion toggles.
 *
 * When `channelId` is provided, save/delete operations use the channel
 * specialist API endpoints instead of shared/profile endpoints.
 */
export function useCardEditing(
  clientOrWsUrl: SettingsApiClient | string,
  selectedScope: string,
  isGlobal: boolean,
  specialists: ResolvedSpecialistDefinition[],
  loadSpecialists: () => Promise<ResolvedSpecialistDefinition[]>,
  modelPresets: ModelPresetInfo[],
  channelId?: string,
) {
  const [editStates, setEditStates] = useState<Record<string, CardEditState>>({})
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set())
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(new Set())
  const [expandedFallbackIds, setExpandedFallbackIds] = useState<Set<string>>(new Set())
  const [customizeInitiatedIds, setCustomizeInitiatedIds] = useState<Set<string>>(new Set())
  const [pendingSaveId, setPendingSaveId] = useState<string | null>(null)
  const [cloningIds, setCloningIds] = useState<Set<string>>(new Set())

  const isChannel = !!channelId

  const startEditing = useCallback((s: ResolvedSpecialistDefinition) => {
    setEditStates((prev) => ({ ...prev, [s.specialistId]: specialistToEditState(s) }))
    setEditingIds((prev) => new Set(prev).add(s.specialistId))
    setCardErrors(({ [s.specialistId]: _, ...rest }) => rest)
  }, [])

  const cancelEditing = useCallback((id: string) => {
    setEditingIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    setEditStates(({ [id]: _, ...rest }) => rest)
    setCardErrors(({ [id]: _, ...rest }) => rest)
    setExpandedFallbackIds((prev) => { const next = new Set(prev); next.delete(id); return next })
  }, [])

  const updateEditField = useCallback((id: string, field: keyof CardEditState, value: string | boolean) => {
    setEditStates((prev) => {
      const currentState = prev[id]
      if (!currentState) {
        return prev
      }

      const nextState: CardEditState = { ...currentState, [field]: value }

      // Auto-normalize reasoning level when model selection changes
      if (
        (field === 'modelId' || field === 'provider') &&
        typeof nextState.modelId === 'string' &&
        nextState.modelId
      ) {
        const supported = getSupportedReasoningLevelsForModelId(nextState.modelId, modelPresets, nextState.provider)
        if (!supported.includes(nextState.reasoningLevel as ManagerReasoningLevel)) {
          nextState.reasoningLevel = supported[supported.length - 1] || 'high'
        }
        if (!modelSupportsWebSearch(nextState.modelId, modelPresets, nextState.provider)) {
          nextState.webSearch = false
        }
      }

      // Auto-normalize fallback reasoning level when fallback selection changes
      if (
        (field === 'fallbackModelId' || field === 'fallbackProvider') &&
        typeof nextState.fallbackModelId === 'string' &&
        nextState.fallbackModelId
      ) {
        const supported = getSupportedReasoningLevelsForModelId(
          nextState.fallbackModelId,
          modelPresets,
          nextState.fallbackProvider,
        )
        if (nextState.fallbackReasoningLevel && !supported.includes(nextState.fallbackReasoningLevel as ManagerReasoningLevel)) {
          nextState.fallbackReasoningLevel = supported[supported.length - 1] || 'high'
        }
      }

      return {
        ...prev,
        [id]: nextState,
      }
    })
  }, [modelPresets])

  /** Wraps an async card action with saving-state tracking and error capture. */
  const withCardAction = useCallback(async (id: string, action: () => Promise<void>, errorLabel: string) => {
    setSavingIds((prev) => new Set(prev).add(id))
    setCardErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    try {
      await action()
    } catch (err) {
      setCardErrors((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : errorLabel,
      }))
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  /** Route save to the appropriate API based on scope. */
  const saveScopedSpecialist = useCallback(async (handle: string, payload: SaveSpecialistPayload) => {
    if (isChannel) {
      await saveChannelSpecialist(clientOrWsUrl, channelId!, handle, payload)
    } else if (isGlobal) {
      await saveSharedSpecialist(clientOrWsUrl, handle, payload)
    } else {
      await saveSpecialist(clientOrWsUrl, selectedScope, handle, payload)
    }
  }, [clientOrWsUrl, selectedScope, isGlobal, isChannel, channelId])

  /** Route delete to the appropriate API based on scope. */
  const deleteScopedSpecialist = useCallback(async (handle: string) => {
    if (isChannel) {
      await deleteChannelSpecialistApi(clientOrWsUrl, channelId!, handle)
    } else if (isGlobal) {
      await deleteSharedSpecialistApi(clientOrWsUrl, handle)
    } else {
      await deleteSpecialist(clientOrWsUrl, selectedScope, handle)
    }
  }, [clientOrWsUrl, selectedScope, isGlobal, isChannel, channelId])

  const handleSave = useCallback(async (id: string) => {
    const state = editStates[id]
    if (!state) return
    const newHandle = normalizeHandle(state.handle)
    const handleChanged = newHandle !== id

    // Validate handle
    if (!newHandle) {
      setCardErrors((prev) => ({ ...prev, [id]: 'Handle cannot be empty' }))
      return
    }
    if (handleChanged && specialists.some((s) => s.specialistId === newHandle)) {
      setCardErrors((prev) => ({ ...prev, [id]: `A specialist with handle "${newHandle}" already exists` }))
      return
    }

    await withCardAction(id, async () => {
      const payload = toSaveSpecialistPayload(state)
      const saveHandle = handleChanged ? newHandle : id

      await saveScopedSpecialist(saveHandle, payload)

      // If handle changed, delete the old file
      if (handleChanged) {
        try {
          await deleteScopedSpecialist(id)
        } catch {
          // Best effort — new file already saved
        }
      }

      setCustomizeInitiatedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
      cancelEditing(id)
      await loadSpecialists()
    }, 'Save failed')
  }, [editStates, specialists, cancelEditing, loadSpecialists, withCardAction, saveScopedSpecialist, deleteScopedSpecialist])

  const requestSave = useCallback((id: string, isBuiltin: boolean) => {
    const state = editStates[id]
    if (!state) return

    if (isBuiltin && !state.pinned) {
      setPendingSaveId(id)
      return
    }

    void handleSave(id)
  }, [editStates, handleSave])

  const confirmPendingSave = useCallback(() => {
    const id = pendingSaveId
    if (!id) return
    setPendingSaveId(null)
    void handleSave(id)
  }, [handleSave, pendingSaveId])

  const cancelPendingSave = useCallback(() => {
    setPendingSaveId(null)
  }, [])

  const handleCreateOverride = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload(specialistToEditState(s))
      if (isChannel) {
        await saveChannelSpecialist(clientOrWsUrl, channelId!, s.specialistId, payload)
      } else {
        await saveSpecialist(clientOrWsUrl, selectedScope, s.specialistId, payload)
      }
      setCustomizeInitiatedIds((prev) => new Set(prev).add(s.specialistId))
      const updatedSpecialists = await loadSpecialists()
      const updated = updatedSpecialists.find((sp) => sp.specialistId === s.specialistId)
      if (updated) startEditing(updated)
    }, 'Failed to create override')
  }, [clientOrWsUrl, selectedScope, isChannel, channelId, loadSpecialists, startEditing, withCardAction])

  const handleInheritedToggleEnabled = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload({
        ...specialistToEditState(s),
        enabled: !s.enabled,
      })
      if (isChannel) {
        await saveChannelSpecialist(clientOrWsUrl, channelId!, s.specialistId, payload)
      } else {
        await saveSpecialist(clientOrWsUrl, selectedScope, s.specialistId, payload)
      }
      await loadSpecialists()
    }, 'Failed to toggle')
  }, [clientOrWsUrl, selectedScope, isChannel, channelId, loadSpecialists, withCardAction])

  const handleGlobalToggleEnabled = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload({
        ...specialistToEditState(s),
        enabled: !s.enabled,
      })
      await saveSharedSpecialist(clientOrWsUrl, s.specialistId, payload)
      await loadSpecialists()
    }, 'Failed to toggle')
  }, [clientOrWsUrl, loadSpecialists, withCardAction])

  const handleProfileToggleEnabled = useCallback(async (s: ResolvedSpecialistDefinition) => {
    await withCardAction(s.specialistId, async () => {
      const payload = toSaveSpecialistPayload({
        ...specialistToEditState(s),
        enabled: !s.enabled,
      })
      if (isChannel) {
        await saveChannelSpecialist(clientOrWsUrl, channelId!, s.specialistId, payload)
      } else {
        await saveSpecialist(clientOrWsUrl, selectedScope, s.specialistId, payload)
      }
      await loadSpecialists()
    }, 'Failed to toggle')
  }, [clientOrWsUrl, selectedScope, isChannel, channelId, loadSpecialists, withCardAction])

  const handleCancelProfileEditing = useCallback(async (id: string) => {
    const wasCustomizeInitiated = customizeInitiatedIds.has(id)
    cancelEditing(id)

    if (wasCustomizeInitiated) {
      setCustomizeInitiatedIds((prev) => { const next = new Set(prev); next.delete(id); return next })
      try {
        await deleteScopedSpecialist(id)
      } catch {
        // Best effort
      }
      await loadSpecialists()
    }
  }, [customizeInitiatedIds, cancelEditing, loadSpecialists, deleteScopedSpecialist])

  const handleRevert = useCallback(async (id: string) => {
    await withCardAction(id, async () => {
      await deleteScopedSpecialist(id)
      cancelEditing(id)
      await loadSpecialists()
    }, 'Revert failed')
  }, [cancelEditing, loadSpecialists, withCardAction, deleteScopedSpecialist])

  const handleDelete = useCallback(async (id: string) => {
    await withCardAction(id, async () => {
      await deleteScopedSpecialist(id)
      cancelEditing(id)
      await loadSpecialists()
    }, 'Delete failed')
  }, [cancelEditing, loadSpecialists, withCardAction, deleteScopedSpecialist])

  const handleClone = useCallback(async (source: ResolvedSpecialistDefinition) => {
    const sourceId = source.specialistId
    setCloningIds((prev) => new Set(prev).add(sourceId))
    setCardErrors((prev) => { const next = { ...prev }; delete next[sourceId]; return next })
    try {
      const existingIds = new Set(specialists.map((s) => s.specialistId))
      const newHandle = generateUniqueCloneHandle(source.specialistId, existingIds)

      const payload: SaveSpecialistPayload = {
        displayName: `${source.displayName} (Copy)`,
        color: pickAvailableColor(specialists),
        enabled: true,
        whenToUse: source.whenToUse,
        modelId: source.modelId,
        provider: source.provider,
        reasoningLevel: (source.reasoningLevel as ManagerReasoningLevel) ?? undefined,
        fallbackModelId: source.fallbackModelId ?? undefined,
        fallbackProvider: source.fallbackProvider ?? undefined,
        fallbackReasoningLevel: (source.fallbackReasoningLevel as ManagerReasoningLevel) ?? undefined,
        pinned: false,
        webSearch: source.webSearch ?? false,
        promptBody: source.promptBody,
      }

      await saveScopedSpecialist(newHandle, payload)

      const updatedSpecialists = await loadSpecialists()
      const created = updatedSpecialists.find((s) => s.specialistId === newHandle)
      if (created) {
        startEditing(created)
        setExpandedPromptIds((prev) => new Set(prev).add(created.specialistId))
      }
    } catch (err) {
      setCardErrors((prev) => ({
        ...prev,
        [sourceId]: err instanceof Error ? err.message : 'Clone failed',
      }))
    } finally {
      setCloningIds((prev) => { const next = new Set(prev); next.delete(sourceId); return next })
    }
  }, [specialists, loadSpecialists, startEditing, saveScopedSpecialist])

  const togglePromptExpand = useCallback((id: string) => {
    setExpandedPromptIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleFallbackExpand = useCallback((id: string) => {
    setExpandedFallbackIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Expand the prompt section for a given specialist ID. */
  const expandPromptForId = useCallback((id: string) => {
    setExpandedPromptIds((prev) => new Set(prev).add(id))
  }, [])

  /** Reset all editing state (used on scope change). */
  const resetEditing = useCallback(() => {
    setEditingIds(new Set())
    setEditStates({})
    setCardErrors({})
    setExpandedPromptIds(new Set())
    setExpandedFallbackIds(new Set())
    setCustomizeInitiatedIds(new Set())
    setPendingSaveId(null)
  }, [])

  return {
    editStates,
    editingIds,
    savingIds,
    cardErrors,
    expandedPromptIds,
    expandedFallbackIds,
    cloningIds,
    pendingSaveId,
    startEditing,
    cancelEditing,
    updateEditField,
    requestSave,
    confirmPendingSave,
    cancelPendingSave,
    handleCreateOverride,
    handleInheritedToggleEnabled,
    handleGlobalToggleEnabled,
    handleProfileToggleEnabled,
    handleCancelProfileEditing,
    handleRevert,
    handleDelete,
    handleClone,
    togglePromptExpand,
    toggleFallbackExpand,
    expandPromptForId,
    resetEditing,
  }
}
