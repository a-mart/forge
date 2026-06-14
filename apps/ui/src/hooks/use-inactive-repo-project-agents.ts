import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RepoProjectAgentInventoryItem } from '@forge/protocol'
import { isCortexProfile, type ProfileTreeRow } from '@/lib/agent-hierarchy'
import { createBuilderSettingsApiClient } from '@/components/settings/settings-api-client'
import {
  fetchProjectResourcesSnapshot,
} from '@/components/settings/project-resources-api'
import {
  getInactiveRepoProjectAgentDefinitions,
  getUnavailableRepoProjectAgentDefinitions,
} from '@/components/settings/repo-project-agent-ui-utils'

export interface RepoProjectAgentSidebarEntry {
  profileId: string
  sessionAgentId: string
  item: RepoProjectAgentInventoryItem
  activatable: boolean
}

function getProfileResourceContext(treeRow: ProfileTreeRow): { profileId: string; sessionAgentId: string } | null {
  if (isCortexProfile(treeRow)) return null
  const profileId = treeRow.profile.profileId
  const representativeSession = treeRow.sessions.find((session) => session.isDefault)
    ?? treeRow.sessions.find((session) => !session.sessionAgent.agentCreatorResult)
  if (!representativeSession) return null
  return {
    profileId,
    sessionAgentId: representativeSession.sessionAgent.agentId,
  }
}

export function useInactiveRepoProjectAgents(options: {
  connected: boolean
  wsUrl?: string
  treeRows: ProfileTreeRow[]
  refreshKey?: string | number
}) {
  const { connected, wsUrl, treeRows, refreshKey = 0 } = options
  const [entriesByProfileId, setEntriesByProfileId] = useState<Map<string, RepoProjectAgentSidebarEntry[]>>(() => new Map())
  const [loading, setLoading] = useState(false)

  const contexts = useMemo(() => {
    const next = new Map<string, { profileId: string; sessionAgentId: string }>()
    for (const row of treeRows) {
      const context = getProfileResourceContext(row)
      if (context) {
        next.set(context.profileId, context)
      }
    }
    return next
  }, [treeRows])

  const refresh = useCallback(async () => {
    if (!connected || !wsUrl || contexts.size === 0) {
      setEntriesByProfileId(new Map())
      return
    }

    setLoading(true)
    const apiClient = createBuilderSettingsApiClient(wsUrl)
    const nextEntries = new Map<string, RepoProjectAgentSidebarEntry[]>()

    await Promise.all(Array.from(contexts.values()).map(async (context) => {
      try {
        const snapshot = await fetchProjectResourcesSnapshot(apiClient, context)
        if (snapshot.warning) return
        const section = snapshot.resources.projectAgents
        const inactive = getInactiveRepoProjectAgentDefinitions(section).map((item) => ({
          profileId: context.profileId,
          sessionAgentId: context.sessionAgentId,
          item,
          activatable: true,
        }))
        const unavailable = getUnavailableRepoProjectAgentDefinitions(section).map((item) => ({
          profileId: context.profileId,
          sessionAgentId: context.sessionAgentId,
          item,
          activatable: false,
        }))
        const combined = [...inactive, ...unavailable]
        if (combined.length > 0) {
          nextEntries.set(context.profileId, combined)
        }
      } catch {
        // Leave profile without sidebar repo definitions on fetch failure.
      }
    }))

    setEntriesByProfileId(nextEntries)
    setLoading(false)
  }, [connected, contexts, wsUrl])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const getEntriesForProfile = useCallback((profileId: string) => {
    return entriesByProfileId.get(profileId) ?? []
  }, [entriesByProfileId])

  return {
    getEntriesForProfile,
    loading,
    refresh,
  }
}
