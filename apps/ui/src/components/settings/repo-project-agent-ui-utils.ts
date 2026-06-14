import { useCallback, useState } from 'react'
import type {
  RepoProjectAgentInventoryItem,
  RepoProjectAgentInventorySection,
} from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { activateRepoProjectAgent } from './project-resources-api'

export function getInactiveRepoProjectAgentDefinitions(
  section: RepoProjectAgentInventorySection | undefined,
): RepoProjectAgentInventoryItem[] {
  if (!section?.exists) return []
  return section.items.filter((item) => !item.activatedAgentId && item.status === 'valid')
}

export function getUnavailableRepoProjectAgentDefinitions(
  section: RepoProjectAgentInventorySection | undefined,
): RepoProjectAgentInventoryItem[] {
  if (!section?.exists) return []
  return section.items.filter(
    (item) => !item.activatedAgentId && item.status !== 'valid' && item.status !== 'local',
  )
}

export function getInactiveRepoProjectAgentEntryKey(entry: {
  profileId: string
  item: Pick<RepoProjectAgentInventoryItem, 'definitionId'>
}): string {
  return `${entry.profileId}:${entry.item.definitionId}`
}

export function matchesRepoProjectAgentSearch(
  item: RepoProjectAgentInventoryItem,
  query: string | undefined,
): boolean {
  if (!query?.trim()) return true
  const lower = query.trim().toLowerCase()
  return (
    item.handle.toLowerCase().includes(lower)
    || (item.displayName?.toLowerCase().includes(lower) ?? false)
    || (item.whenToUse?.toLowerCase().includes(lower) ?? false)
    || item.definitionId.toLowerCase().includes(lower)
  )
}

export function useRepoProjectAgentActivation(options: {
  apiClient: SettingsApiClient
  context: { profileId: string; sessionAgentId: string }
  onActivated?: (agentId: string) => void
}) {
  const { apiClient, context, onActivated } = options
  const [activatingId, setActivatingId] = useState<string | null>(null)
  const [activateError, setActivateError] = useState<string | null>(null)

  const handleActivate = useCallback(async (item: RepoProjectAgentInventoryItem) => {
    setActivatingId(item.definitionId)
    setActivateError(null)
    try {
      const result = await activateRepoProjectAgent(apiClient, {
        ...context,
        definitionId: item.definitionId,
        mode: 'create',
        applyRecommendedModel: Boolean(item.recommendedModel),
        approvedCapabilities: item.requestedCapabilities,
      })
      onActivated?.(result.agentId)
      return result
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Activation failed.')
      return undefined
    } finally {
      setActivatingId(null)
    }
  }, [apiClient, context, onActivated])

  return {
    activatingId,
    activateError,
    setActivateError,
    handleActivate,
  }
}
