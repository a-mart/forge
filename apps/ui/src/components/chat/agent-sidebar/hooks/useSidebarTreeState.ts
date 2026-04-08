import { useCallback, useMemo, useState } from 'react'
import { isCortexProfile, type ProfileTreeRow } from '@/lib/agent-hierarchy'
import { MAX_VISIBLE_SESSIONS, SESSION_PAGE_SIZE } from '../constants'
import { filterTreeRows, parseSearchQuery } from '../utils'

interface UseSidebarTreeStateOptions {
  treeRows: ProfileTreeRow[]
  searchQuery: string
  onRequestSessionWorkers?: (sessionId: string) => void
}

interface UseSidebarTreeStateReturn {
  activeDragId: string | null
  setActiveDragId: (value: string | null) => void
  expandedSessionIds: Set<string>
  expandedWorkerListSessionIds: Set<string>
  regularRows: ProfileTreeRow[]
  cortexRow: ProfileTreeRow | null
  parsedSearch: ReturnType<typeof parseSearchQuery>
  isSearchActive: boolean
  matchCount: number
  toggleSessionCollapsed: (sessionId: string) => void
  showMoreSessions: (profileId: string) => void
  showLessSessions: (profileId: string) => void
  toggleWorkerListExpanded: (sessionId: string) => void
  getVisibleSessionLimit: (profileId: string) => number
}

export function useSidebarTreeState({
  treeRows,
  searchQuery,
  onRequestSessionWorkers,
}: UseSidebarTreeStateOptions): UseSidebarTreeStateReturn {
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  const [sessionListLimits, setSessionListLimits] = useState<Record<string, number>>({})
  const [expandedWorkerListSessionIds, setExpandedWorkerListSessionIds] = useState<Set<string>>(() => new Set())

  const parsedSearch = useMemo(() => parseSearchQuery(searchQuery), [searchQuery])
  const isSearchActive = parsedSearch.term.length > 0

  const { filtered: filteredTreeRows, matchCount } = useMemo(
    () => filterTreeRows(treeRows, searchQuery),
    [treeRows, searchQuery],
  )

  const sourceRows = useMemo(
    () => (isSearchActive ? filteredTreeRows : treeRows),
    [filteredTreeRows, isSearchActive, treeRows],
  )

  const regularRows = useMemo(
    () => sourceRows.filter((row) => !isCortexProfile(row)),
    [sourceRows],
  )

  const cortexRow = useMemo(
    () => sourceRows.find((row) => isCortexProfile(row)) ?? null,
    [sourceRows],
  )

  const toggleSessionCollapsed = useCallback((sessionId: string) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
        onRequestSessionWorkers?.(sessionId)
      }
      return next
    })
  }, [onRequestSessionWorkers])

  const showMoreSessions = useCallback((profileId: string) => {
    setSessionListLimits((prev) => ({
      ...prev,
      [profileId]: (prev[profileId] ?? MAX_VISIBLE_SESSIONS) + SESSION_PAGE_SIZE,
    }))
  }, [])

  const showLessSessions = useCallback((profileId: string) => {
    setSessionListLimits((prev) => {
      const next = { ...prev }
      delete next[profileId]
      return next
    })
  }, [])

  const toggleWorkerListExpanded = useCallback((sessionId: string) => {
    setExpandedWorkerListSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
        onRequestSessionWorkers?.(sessionId)
      }
      return next
    })
  }, [onRequestSessionWorkers])

  const getVisibleSessionLimit = useCallback((profileId: string) => {
    return isSearchActive ? Infinity : (sessionListLimits[profileId] ?? MAX_VISIBLE_SESSIONS)
  }, [isSearchActive, sessionListLimits])

  return {
    activeDragId,
    setActiveDragId,
    expandedSessionIds,
    expandedWorkerListSessionIds,
    regularRows,
    cortexRow,
    parsedSearch,
    isSearchActive,
    matchCount,
    toggleSessionCollapsed,
    showMoreSessions,
    showLessSessions,
    toggleWorkerListExpanded,
    getVisibleSessionLimit,
  }
}
