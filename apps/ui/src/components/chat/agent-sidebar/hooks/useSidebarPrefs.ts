import { useCallback, useEffect, useRef, useState } from 'react'
import { readSidebarModelIconsPref, readSidebarProviderUsagePref } from '@/lib/sidebar-prefs'

const SIDEBAR_PREF_CHANGE_EVENT = 'forge-sidebar-pref-change'
const COLLAPSED_PROFILES_KEY = 'forge-sidebar-collapsed-profiles'
const SEARCH_QUERY_KEY = 'forge-sidebar-search-query'
const SORT_PREFERENCE_KEY = 'forge-sidebar-sort-preference'

export type SidebarSortPreference = 'manual' | 'created_at'

interface UseSidebarPrefsReturn {
  collapsedProfileIds: Set<string>
  toggleProfileCollapsed: (profileId: string) => void
  searchQuery: string
  setSearchQuery: (value: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  showModelIcons: boolean
  showProviderUsage: boolean
  sortPreference: SidebarSortPreference
  setSortPreference: (value: SidebarSortPreference) => void
}

function readStoredCollapsedProfiles(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_PROFILES_KEY)
    if (!stored) return new Set()
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) ? new Set(parsed) : new Set()
  } catch {
    return new Set()
  }
}

function readStoredSearchQuery(): string {
  try {
    return localStorage.getItem(SEARCH_QUERY_KEY) ?? ''
  } catch {
    return ''
  }
}

function readStoredSortPreference(): SidebarSortPreference {
  try {
    return localStorage.getItem(SORT_PREFERENCE_KEY) === 'created_at' ? 'created_at' : 'manual'
  } catch {
    return 'manual'
  }
}

export function useSidebarPrefs(): UseSidebarPrefsReturn {
  const [collapsedProfileIds, setCollapsedProfileIds] = useState<Set<string>>(() => readStoredCollapsedProfiles())
  const [searchQuery, setSearchQuery] = useState(() => readStoredSearchQuery())
  const [showModelIcons, setShowModelIcons] = useState(() => readSidebarModelIconsPref())
  const [showProviderUsage, setShowProviderUsage] = useState(() => readSidebarProviderUsagePref())
  const [sortPreference, setSortPreference] = useState<SidebarSortPreference>(() => readStoredSortPreference())
  const searchInputRef = useRef<HTMLInputElement>(null)

  const toggleProfileCollapsed = useCallback((profileId: string) => {
    setCollapsedProfileIds((prev) => {
      const next = new Set(prev)
      if (next.has(profileId)) {
        next.delete(profileId)
      } else {
        next.add(profileId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const update = () => {
      setShowModelIcons(readSidebarModelIconsPref())
      setShowProviderUsage(readSidebarProviderUsagePref())
    }

    window.addEventListener(SIDEBAR_PREF_CHANGE_EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(SIDEBAR_PREF_CHANGE_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_PROFILES_KEY, JSON.stringify([...collapsedProfileIds]))
    } catch {
      // Ignore localStorage write failures (quota, etc.)
    }
  }, [collapsedProfileIds])

  // Debounce localStorage persistence for search query (~300ms).
  // Input state updates immediately; only the storage write is deferred.
  // Each keystroke resets the timer via the cleanup return, so only the
  // final value after the user stops typing gets persisted.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (searchQuery) {
          localStorage.setItem(SEARCH_QUERY_KEY, searchQuery)
        } else {
          localStorage.removeItem(SEARCH_QUERY_KEY)
        }
      } catch {
        // Ignore localStorage write failures (quota, etc.)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    try {
      localStorage.setItem(SORT_PREFERENCE_KEY, sortPreference)
    } catch {
      // Ignore localStorage write failures (quota, etc.)
    }
  }, [sortPreference])

  return {
    collapsedProfileIds,
    toggleProfileCollapsed,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    showModelIcons,
    showProviderUsage,
    sortPreference,
    setSortPreference,
  }
}
