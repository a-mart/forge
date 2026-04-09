/* eslint-disable react-refresh/only-export-components -- React context must be co-located with its Provider */
import { createContext, useCallback, useEffect, useMemo, useReducer } from 'react'
import type { HelpCategory, HelpState } from './help-types'
import { initializeHelpContent } from './help-registry'

const TOUR_COMPLETED_KEY = 'forge-help-tour-completed'

function loadTourCompleted(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(TOUR_COMPLETED_KEY) === 'true'
  } catch {
    return false
  }
}

function persistTourCompleted(completed: boolean): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(TOUR_COMPLETED_KEY, String(completed))
  } catch {
    // Ignore localStorage failures.
  }
}

// --- Reducer ---

type HelpAction =
  | { type: 'OPEN_DRAWER'; contextKey?: string; articleId?: string }
  | { type: 'CLOSE_DRAWER' }
  | { type: 'SET_CONTEXT_KEY'; key: string }
  | { type: 'OPEN_ARTICLE'; id: string | null }
  | { type: 'OPEN_SHORTCUT_OVERLAY' }
  | { type: 'CLOSE_SHORTCUT_OVERLAY' }
  | { type: 'START_TOUR' }
  | { type: 'NEXT_TOUR_STEP' }
  | { type: 'COMPLETE_TOUR' }
  | { type: 'SET_SEARCH'; query: string }
  | { type: 'SET_CATEGORY'; category: HelpCategory | null }

const initialState: HelpState = {
  isDrawerOpen: false,
  activeArticleId: null,
  activeCategory: null,
  searchQuery: '',
  contextKey: '',
  isShortcutOverlayOpen: false,
  isTourActive: false,
  tourStep: 0,
  hasCompletedTour: loadTourCompleted(),
}

function helpReducer(state: HelpState, action: HelpAction): HelpState {
  switch (action.type) {
    case 'OPEN_DRAWER':
      return {
        ...state,
        isDrawerOpen: true,
        isShortcutOverlayOpen: false,
        contextKey: action.contextKey ?? state.contextKey,
        activeArticleId: action.articleId ?? null,
        activeCategory: null,
        searchQuery: '',
      }
    case 'CLOSE_DRAWER':
      return {
        ...state,
        isDrawerOpen: false,
        activeArticleId: null,
        searchQuery: '',
      }
    case 'SET_CONTEXT_KEY':
      return {
        ...state,
        contextKey: action.key,
      }
    case 'OPEN_ARTICLE':
      return {
        ...state,
        activeArticleId: action.id || null,
        isDrawerOpen: true,
        isShortcutOverlayOpen: false,
      }
    case 'OPEN_SHORTCUT_OVERLAY':
      return {
        ...state,
        isShortcutOverlayOpen: true,
        isDrawerOpen: false,
      }
    case 'CLOSE_SHORTCUT_OVERLAY':
      return {
        ...state,
        isShortcutOverlayOpen: false,
      }
    case 'START_TOUR':
      return {
        ...state,
        isTourActive: true,
        tourStep: 0,
        isDrawerOpen: false,
        isShortcutOverlayOpen: false,
      }
    case 'NEXT_TOUR_STEP':
      return {
        ...state,
        tourStep: state.tourStep + 1,
      }
    case 'COMPLETE_TOUR':
      return {
        ...state,
        isTourActive: false,
        tourStep: 0,
        hasCompletedTour: true,
      }
    case 'SET_SEARCH':
      return {
        ...state,
        searchQuery: action.query,
        activeArticleId: null,
      }
    case 'SET_CATEGORY':
      return {
        ...state,
        activeCategory: action.category,
        activeArticleId: null,
      }
  }
}

// --- Context ---

export interface HelpActions {
  openDrawer: (contextKey?: string, articleId?: string) => void
  closeDrawer: () => void
  setContextKey: (key: string) => void
  openArticle: (id: string | null) => void
  toggleShortcutOverlay: () => void
  openShortcutOverlay: () => void
  closeShortcutOverlay: () => void
  startTour: () => void
  nextTourStep: () => void
  completeTour: () => void
  setSearch: (query: string) => void
  setCategory: (category: HelpCategory | null) => void
}

export type HelpContextValue = HelpState & HelpActions

export const HelpContext = createContext<HelpContextValue | null>(null)

// --- Provider ---

interface HelpProviderProps {
  children: React.ReactNode
}

export function HelpProvider({ children }: HelpProviderProps) {
  const [state, dispatch] = useReducer(helpReducer, initialState)

  // Initialize the content registry on mount
  useEffect(() => {
    initializeHelpContent()
  }, [])

  // Persist tour completion to localStorage
  useEffect(() => {
    if (state.hasCompletedTour) {
      persistTourCompleted(true)
    }
  }, [state.hasCompletedTour])

  const openDrawer = useCallback((contextKey?: string, articleId?: string) => {
    dispatch({ type: 'OPEN_DRAWER', contextKey, articleId })
  }, [])

  const closeDrawer = useCallback(() => {
    dispatch({ type: 'CLOSE_DRAWER' })
  }, [])

  const setContextKey = useCallback((key: string) => {
    dispatch({ type: 'SET_CONTEXT_KEY', key })
  }, [])

  const openArticle = useCallback((id: string | null) => {
    dispatch({ type: 'OPEN_ARTICLE', id })
  }, [])

  const openShortcutOverlay = useCallback(() => {
    dispatch({ type: 'OPEN_SHORTCUT_OVERLAY' })
  }, [])

  const closeShortcutOverlay = useCallback(() => {
    dispatch({ type: 'CLOSE_SHORTCUT_OVERLAY' })
  }, [])

  const toggleShortcutOverlay = useCallback(() => {
    if (state.isShortcutOverlayOpen) {
      dispatch({ type: 'CLOSE_SHORTCUT_OVERLAY' })
    } else {
      dispatch({ type: 'OPEN_SHORTCUT_OVERLAY' })
    }
  }, [state.isShortcutOverlayOpen])

  const startTour = useCallback(() => {
    dispatch({ type: 'START_TOUR' })
  }, [])

  const nextTourStep = useCallback(() => {
    dispatch({ type: 'NEXT_TOUR_STEP' })
  }, [])

  const completeTour = useCallback(() => {
    dispatch({ type: 'COMPLETE_TOUR' })
  }, [])

  const setSearch = useCallback((query: string) => {
    dispatch({ type: 'SET_SEARCH', query })
  }, [])

  const setCategory = useCallback((category: HelpCategory | null) => {
    dispatch({ type: 'SET_CATEGORY', category })
  }, [])

  const value = useMemo<HelpContextValue>(() => ({
    ...state,
    openDrawer,
    closeDrawer,
    setContextKey,
    openArticle,
    toggleShortcutOverlay,
    openShortcutOverlay,
    closeShortcutOverlay,
    startTour,
    nextTourStep,
    completeTour,
    setSearch,
    setCategory,
  }), [
    state,
    openDrawer,
    closeDrawer,
    setContextKey,
    openArticle,
    toggleShortcutOverlay,
    openShortcutOverlay,
    closeShortcutOverlay,
    startTour,
    nextTourStep,
    completeTour,
    setSearch,
    setCategory,
  ])

  return (
    <HelpContext.Provider value={value}>
      {children}
    </HelpContext.Provider>
  )
}
