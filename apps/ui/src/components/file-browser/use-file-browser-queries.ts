import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FileContentResult,
  FileCountResult,
  FileEntry,
  FileListResult,
  FileSearchResult,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export type {
  FileContentResult,
  FileCountResult,
  FileEntry,
  FileListResult,
  FileSearchResult,
}

/* ------------------------------------------------------------------ */
/*  Generic fetch wrapper                                              */
/* ------------------------------------------------------------------ */

async function fetchFileBrowserApi<T>(
  wsUrl: string,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const searchParams = new URLSearchParams(params)
  const url = resolveApiEndpoint(wsUrl, `${path}?${searchParams.toString()}`)
  const response = await fetch(url)

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }

  return response.json() as Promise<T>
}

/* ------------------------------------------------------------------ */
/*  Lightweight query hook (same pattern as use-diff-queries.ts)       */
/* ------------------------------------------------------------------ */

interface QueryResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

const MAX_CACHE_ENTRIES = 200
const queryCache = new Map<string, { data: unknown; fetchedAt: number }>()

function evictOldestCacheEntries() {
  if (queryCache.size <= MAX_CACHE_ENTRIES) return
  // Map iteration order is insertion-order; delete oldest entries first
  const toDelete = queryCache.size - MAX_CACHE_ENTRIES
  let deleted = 0
  for (const key of queryCache.keys()) {
    if (deleted >= toDelete) break
    queryCache.delete(key)
    deleted++
  }
}

function useSimpleQuery<T>(
  queryKey: string,
  fetchFn: () => Promise<T>,
  options: { enabled: boolean; staleTime: number },
): QueryResult<T> {
  const [data, setData] = useState<T | null>(() => {
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      return cached.data as T
    }
    return null
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchKeyRef = useRef(0)
  const prevQueryKeyRef = useRef(queryKey)

  // Reset state when queryKey changes to prevent stale data flash
  if (prevQueryKeyRef.current !== queryKey) {
    prevQueryKeyRef.current = queryKey
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setData(cached.data as T)
    } else {
      setData(null)
    }
    setError(null)
  }

  const doFetch = useCallback(() => {
    if (!options.enabled) {
      setError(null)
      return
    }

    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setData(cached.data as T)
      setError(null)
      return
    }

    const key = ++fetchKeyRef.current
    setIsLoading(true)

    void fetchFn()
      .then((result) => {
        if (key !== fetchKeyRef.current) return
        queryCache.set(queryKey, { data: result, fetchedAt: Date.now() })
        evictOldestCacheEntries()
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (key !== fetchKeyRef.current) return
        setError(err instanceof Error ? err.message : 'Unknown error')
      })
      .finally(() => {
        if (key !== fetchKeyRef.current) return
        setIsLoading(false)
      })
  }, [queryKey, options.enabled, options.staleTime, fetchFn])

  const refetch = useCallback(() => {
    queryCache.delete(queryKey)
    doFetch()
  }, [queryKey, doFetch])

  useEffect(() => {
    doFetch()
  }, [doFetch])

  return { data, isLoading: isLoading && !data, error, refetch }
}

/* ------------------------------------------------------------------ */
/*  Public hooks                                                       */
/* ------------------------------------------------------------------ */

export function useDirectoryListing(
  wsUrl: string,
  agentId: string | null,
  dirPath: string,
) {
  const queryKey = `files:list:${agentId ?? ''}:${dirPath}`
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileListResult>(wsUrl, '/api/files/list', {
        agentId: agentId!,
        path: dirPath,
      }),
    [wsUrl, agentId, dirPath],
  )

  return useSimpleQuery<FileListResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 30_000,
  })
}

export function useFileCount(wsUrl: string, agentId: string | null) {
  const queryKey = `files:count:${agentId ?? ''}`
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileCountResult>(wsUrl, '/api/files/count', {
        agentId: agentId!,
      }),
    [wsUrl, agentId],
  )

  return useSimpleQuery<FileCountResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 120_000,
  })
}

export function useFileSearch(
  wsUrl: string,
  agentId: string | null,
  query: string,
  limit = 50,
) {
  const queryKey = `files:search:${agentId ?? ''}:${query}:${limit}`
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileSearchResult>(wsUrl, '/api/files/search', {
        agentId: agentId!,
        query,
        limit: String(limit),
      }),
    [wsUrl, agentId, query, limit],
  )

  return useSimpleQuery<FileSearchResult>(queryKey, fetchFn, {
    enabled: !!agentId && query.trim().length >= 2,
    staleTime: 30_000,
  })
}

export function useFileContent(
  wsUrl: string,
  agentId: string | null,
  filePath: string | null,
) {
  const queryKey = `files:content:${agentId ?? ''}:${filePath ?? ''}`
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileContentResult>(wsUrl, '/api/files/content', {
        agentId: agentId!,
        path: filePath!,
      }),
    [wsUrl, agentId, filePath],
  )

  return useSimpleQuery<FileContentResult>(queryKey, fetchFn, {
    enabled: !!agentId && !!filePath,
    staleTime: 30_000,
  })
}

/** Invalidate all file browser caches (call on manual refresh) */
export function invalidateFileBrowserCaches() {
  for (const key of queryCache.keys()) {
    if (key.startsWith('files:')) {
      queryCache.delete(key)
    }
  }
}
