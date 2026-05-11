import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY_PREFIX = 'forge:collab:v1:collapsed-categories:'

function readCollapsedCategories(workspaceId: string): Set<string> {
  try {
    const stored = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`)
    if (!stored) {
      return new Set()
    }

    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

/**
 * Merge collapsed category state from all workspace localStorage keys.
 *
 * Category IDs are globally unique UUIDs, so a single merged Set is safe.
 */
function readMergedCollapsedCategories(workspaceIds: readonly string[]): Set<string> {
  const merged = new Set<string>()
  for (const wsId of workspaceIds) {
    for (const catId of readCollapsedCategories(wsId)) {
      merged.add(catId)
    }
  }
  return merged
}

/**
 * Persist collapsed category IDs to all workspace keys.
 *
 * Each workspace's key stores the full merged Set.  Extra category IDs that
 * belong to other workspaces are harmless noise — they never match real
 * categories in a different workspace because IDs are unique UUIDs.
 */
function writeCollapsedCategories(workspaceIds: readonly string[], ids: Set<string>): void {
  const serialised = JSON.stringify([...ids])
  for (const wsId of workspaceIds) {
    try {
      window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${wsId}`, serialised)
    } catch {
      // Ignore localStorage write failures.
    }
  }
}

/**
 * Sidebar collapsed-category preferences scoped to one or more collab
 * workspaces.
 *
 * Accepts an array of workspace IDs so multi-backend collapse state is
 * loaded and persisted correctly — each workspace's localStorage key is
 * read on mount and written on change.
 */
export function useCollabSidebarPrefs(workspaceIds: readonly string[]) {
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(() => readMergedCollapsedCategories(workspaceIds))

  // Stable serialised key for dep comparison (avoids re-reading on every render
  // when the array reference changes but contents are identical).
  const idsKey = workspaceIds.join(',')
  const workspaceIdsRef = useRef(workspaceIds)

  // Keep ref current via effect (refs must not be assigned during render).
  useEffect(() => {
    workspaceIdsRef.current = workspaceIds
  })

  useEffect(() => {
    setCollapsedCategoryIds(readMergedCollapsedCategories(workspaceIdsRef.current))
  }, [idsKey])

  useEffect(() => {
    if (workspaceIdsRef.current.length === 0) {
      return
    }

    writeCollapsedCategories(workspaceIdsRef.current, collapsedCategoryIds)
  }, [collapsedCategoryIds])

  const toggleCategoryCollapsed = useCallback((categoryId: string) => {
    setCollapsedCategoryIds((previous) => {
      const next = new Set(previous)
      if (next.has(categoryId)) {
        next.delete(categoryId)
      } else {
        next.add(categoryId)
      }
      return next
    })
  }, [])

  return {
    collapsedCategoryIds,
    toggleCategoryCollapsed,
  }
}
