import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY_PREFIX = 'forge:collab:v1:collapsed-categories:'

function readCollapsedCategories(workspaceId?: string): Set<string> {
  if (!workspaceId) {
    return new Set()
  }

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

export function useCollabSidebarPrefs(workspaceId?: string) {
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(() => readCollapsedCategories(workspaceId))

  useEffect(() => {
    setCollapsedCategoryIds(readCollapsedCategories(workspaceId))
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      return
    }

    try {
      window.localStorage.setItem(
        `${STORAGE_KEY_PREFIX}${workspaceId}`,
        JSON.stringify([...collapsedCategoryIds]),
      )
    } catch {
      // Ignore localStorage write failures.
    }
  }, [collapsedCategoryIds, workspaceId])

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
