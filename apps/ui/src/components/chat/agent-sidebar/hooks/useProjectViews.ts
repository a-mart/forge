import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const PROJECT_VIEWS_STORAGE_KEY = 'forge-sidebar-project-views'

export interface SidebarProjectView {
  id: string
  name: string
  projectKeys: string[]
}

interface StoredProjectViews {
  version: 1
  activeViewId: string | null
  views: SidebarProjectView[]
}

const EMPTY_PROJECT_VIEWS: StoredProjectViews = {
  version: 1,
  activeViewId: null,
  views: [],
}

function normalizeProjectView(value: unknown): SidebarProjectView | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return null
  if (!Array.isArray(record.projectKeys)) return null

  const name = record.name.trim()
  const projectKeys = [...new Set(record.projectKeys.filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  ))]
  if (!record.id || !name || projectKeys.length === 0) return null
  return { id: record.id, name, projectKeys }
}

export function readStoredProjectViews(): StoredProjectViews {
  try {
    const raw = localStorage.getItem(PROJECT_VIEWS_STORAGE_KEY)
    if (!raw) return EMPTY_PROJECT_VIEWS
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version !== 1 || !Array.isArray(parsed.views)) return EMPTY_PROJECT_VIEWS

    const seenIds = new Set<string>()
    const views = parsed.views.flatMap((value) => {
      const view = normalizeProjectView(value)
      if (!view || seenIds.has(view.id)) return []
      seenIds.add(view.id)
      return [view]
    })
    const activeViewId = typeof parsed.activeViewId === 'string'
      && views.some((view) => view.id === parsed.activeViewId)
      ? parsed.activeViewId
      : null
    return { version: 1, activeViewId, views }
  } catch {
    return EMPTY_PROJECT_VIEWS
  }
}

function persistProjectViews(state: StoredProjectViews): void {
  try {
    localStorage.setItem(PROJECT_VIEWS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Keep the in-memory preference working when localStorage is unavailable.
  }
}

function createViewId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `view-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface SaveSidebarProjectViewInput {
  id?: string
  name: string
  projectKeys: string[]
  activate?: boolean
}

export interface UseProjectViewsReturn {
  views: SidebarProjectView[]
  activeViewId: string | null
  activeView: SidebarProjectView | null
  activeProjectKeys: Set<string> | null
  setActiveView: (viewId: string | null) => void
  saveView: (input: SaveSidebarProjectViewInput) => string
  deleteView: (viewId: string) => void
}

export function useProjectViews(): UseProjectViewsReturn {
  const [state, setState] = useState<StoredProjectViews>(() => readStoredProjectViews())
  const stateRef = useRef(state)

  useEffect(() => {
    const refresh = () => {
      const next = readStoredProjectViews()
      stateRef.current = next
      setState(next)
    }
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const updateState = useCallback((buildNext: (current: StoredProjectViews) => StoredProjectViews) => {
    const next = buildNext(stateRef.current)
    stateRef.current = next
    setState(next)
    persistProjectViews(next)
  }, [])

  const setActiveView = useCallback((viewId: string | null) => {
    updateState((current) => ({
      ...current,
      activeViewId: viewId && current.views.some((view) => view.id === viewId) ? viewId : null,
    }))
  }, [updateState])

  const saveView = useCallback((input: SaveSidebarProjectViewInput): string => {
    const id = input.id ?? createViewId()
    const view: SidebarProjectView = {
      id,
      name: input.name.trim(),
      projectKeys: [...new Set(input.projectKeys)],
    }
    updateState((current) => {
      const existingIndex = current.views.findIndex((entry) => entry.id === id)
      const views = existingIndex === -1
        ? [...current.views, view]
        : current.views.map((entry) => entry.id === id ? view : entry)
      return {
        ...current,
        views,
        activeViewId: input.activate ? id : current.activeViewId,
      }
    })
    return id
  }, [updateState])

  const deleteView = useCallback((viewId: string) => {
    updateState((current) => ({
      ...current,
      activeViewId: current.activeViewId === viewId ? null : current.activeViewId,
      views: current.views.filter((view) => view.id !== viewId),
    }))
  }, [updateState])

  const activeView = useMemo(
    () => state.views.find((view) => view.id === state.activeViewId) ?? null,
    [state.activeViewId, state.views],
  )
  const activeProjectKeys = useMemo(
    () => activeView ? new Set(activeView.projectKeys) : null,
    [activeView],
  )

  return {
    views: state.views,
    activeViewId: state.activeViewId,
    activeView,
    activeProjectKeys,
    setActiveView,
    saveView,
    deleteView,
  }
}
