import { useCallback, useState } from 'react'
import type { ResolvedSpecialistDefinition } from '@forge/protocol'
import {
  fetchWorkerTemplate,
  saveSpecialist,
  saveSharedSpecialist,
  type SaveSpecialistPayload,
} from '../../specialists-api'
import {
  normalizeHandle,
  handleToDisplayName,
  pickAvailableColor,
} from '../utils'
import {
  DEFAULT_WHEN_TO_USE,
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING_LEVEL,
} from '../types'

/**
 * Manages the new specialist creation form state and submission.
 */
export function useNewSpecialistForm(
  wsUrl: string,
  selectedScope: string,
  isGlobal: boolean,
  specialists: ResolvedSpecialistDefinition[],
  loadSpecialists: () => Promise<ResolvedSpecialistDefinition[]>,
  startEditing: (s: ResolvedSpecialistDefinition) => void,
  expandPromptForId: (id: string) => void,
) {
  const [showNewForm, setShowNewForm] = useState(false)
  const [newHandle, setNewHandle] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newHandleDerived, setNewHandleDerived] = useState(true)
  const [newCreating, setNewCreating] = useState(false)
  const [newError, setNewError] = useState<string | null>(null)

  const normalizedNewHandle = normalizeHandle(newHandle)
  const handleConflict = normalizedNewHandle
    ? specialists.some((s) => s.specialistId === normalizedNewHandle)
    : false
  const newHandleValid = normalizedNewHandle.length > 0 && !handleConflict

  function resetNewForm() {
    setNewHandle('')
    setNewDisplayName('')
    setNewHandleDerived(true)
    setNewCreating(false)
    setNewError(null)
  }

  const handleNewHandleChange = useCallback((raw: string) => {
    setNewHandle(raw)
    setNewError(null)
    if (newHandleDerived) {
      const normalized = normalizeHandle(raw)
      setNewDisplayName(normalized ? handleToDisplayName(normalized) : '')
    }
  }, [newHandleDerived])

  const handleNewDisplayNameChange = useCallback((value: string) => {
    setNewDisplayName(value)
    setNewHandleDerived(false)
  }, [])

  const handleCancelNew = useCallback(() => {
    setShowNewForm(false)
    resetNewForm()
  }, [])

  const handleCreateNew = useCallback(async () => {
    if (!newHandleValid) return
    setNewCreating(true)
    setNewError(null)

    try {
      // Fetch worker template for system prompt
      let template: string
      try {
        template = await fetchWorkerTemplate(wsUrl)
      } catch {
        template = [
          'You are a worker agent in a swarm.',
          '- You can list agents and send messages to other agents.',
          '- Use coding tools (read/bash/edit/write) to execute implementation tasks.',
          '- Report progress and outcomes back to the manager using send_message_to_agent.',
          '- You are not user-facing.',
        ].join('\n')
      }

      const displayName = newDisplayName.trim() || handleToDisplayName(normalizedNewHandle)
      const color = pickAvailableColor(specialists)

      const payload: SaveSpecialistPayload = {
        displayName,
        color,
        enabled: true,
        whenToUse: DEFAULT_WHEN_TO_USE,
        modelId: DEFAULT_MODEL_ID,
        provider: 'openai-codex',
        reasoningLevel: DEFAULT_REASONING_LEVEL,
        promptBody: template,
      }

      if (isGlobal) {
        await saveSharedSpecialist(wsUrl, normalizedNewHandle, payload)
      } else {
        await saveSpecialist(wsUrl, selectedScope, normalizedNewHandle, payload)
      }

      const updatedSpecialists = await loadSpecialists()
      setShowNewForm(false)
      resetNewForm()

      // Open the new card in edit mode
      const created = updatedSpecialists.find((s) => s.specialistId === normalizedNewHandle)
      if (created) {
        startEditing(created)
        expandPromptForId(created.specialistId)
      }
    } catch (err) {
      setNewError(err instanceof Error ? err.message : 'Failed to create specialist')
    } finally {
      setNewCreating(false)
    }
  }, [
    wsUrl,
    selectedScope,
    isGlobal,
    normalizedNewHandle,
    newDisplayName,
    newHandleValid,
    specialists,
    loadSpecialists,
    startEditing,
    expandPromptForId,
  ])

  /** Reset the new form (used on scope change). */
  const resetForm = useCallback(() => {
    setShowNewForm(false)
    resetNewForm()
  }, [])

  return {
    showNewForm,
    setShowNewForm,
    newHandle,
    newDisplayName,
    normalizedNewHandle,
    handleConflict,
    newHandleValid,
    newCreating,
    newError,
    handleNewHandleChange,
    handleNewDisplayNameChange,
    handleCancelNew,
    handleCreateNew,
    resetForm,
  }
}
