import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

/* ------------------------------------------------------------------ */
/*  Types matching the backend git-diff-service                       */
/* ------------------------------------------------------------------ */

export interface GitFileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'
  oldPath?: string
  additions?: number
  deletions?: number
}

export interface GitStatusResult {
  files: GitFileStatus[]
  branch: string
  repoName: string
  summary: { filesChanged: number; insertions: number; deletions: number }
}

export interface GitDiffResult {
  oldContent: string
  newContent: string
  truncated?: boolean
  reason?: string
}

export interface GitLogEntry {
  sha: string
  shortSha: string
  message: string
  author: string
  date: string
  filesChanged: number
}

export interface GitLogResult {
  commits: GitLogEntry[]
  hasMore: boolean
}

export interface GitCommitDetail {
  sha: string
  message: string
  author: string
  date: string
  files: GitFileStatus[]
}

/* ------------------------------------------------------------------ */
/*  Generic fetch wrapper                                             */
/* ------------------------------------------------------------------ */

async function fetchGitApi<T>(wsUrl: string, path: string, params: Record<string, string>): Promise<T> {
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
/*  Lightweight query hook (replaces TanStack Query for this module)  */
/*  Follows the same staleTime / refetchOnWindowFocus semantics       */
/* ------------------------------------------------------------------ */

interface QueryResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

// Simple in-memory cache shared across hooks
const queryCache = new Map<string, { data: unknown; fetchedAt: number }>()

function useSimpleQuery<T>(
  queryKey: string,
  fetchFn: () => Promise<T>,
  options: { enabled: boolean; staleTime: number; refetchOnWindowFocus?: boolean },
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

  const doFetch = useCallback(() => {
    if (!options.enabled) return

    // Check cache freshness
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

  // Initial fetch and re-fetch on key change
  useEffect(() => {
    doFetch()
  }, [doFetch])

  // Refetch on window focus
  useEffect(() => {
    if (!options.refetchOnWindowFocus || !options.enabled) return

    const handleFocus = () => {
      const cached = queryCache.get(queryKey)
      if (!cached || Date.now() - cached.fetchedAt >= options.staleTime) {
        doFetch()
      }
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [options.refetchOnWindowFocus, options.enabled, queryKey, options.staleTime, doFetch])

  return { data, isLoading: isLoading && !data, error, refetch }
}

/* ------------------------------------------------------------------ */
/*  Public hooks                                                      */
/* ------------------------------------------------------------------ */

export function useGitStatus(wsUrl: string, agentId: string | null) {
  const queryKey = `git:status:${agentId ?? ''}`
  const fetchFn = useCallback(
    () => fetchGitApi<GitStatusResult>(wsUrl, '/api/git/status', { agentId: agentId! }),
    [wsUrl, agentId],
  )

  return useSimpleQuery<GitStatusResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitFileDiff(wsUrl: string, agentId: string | null, file: string | null) {
  const queryKey = `git:diff:${agentId ?? ''}:${file ?? ''}`
  const fetchFn = useCallback(
    () => fetchGitApi<GitDiffResult>(wsUrl, '/api/git/diff', { agentId: agentId!, file: file! }),
    [wsUrl, agentId, file],
  )

  return useSimpleQuery<GitDiffResult>(queryKey, fetchFn, {
    enabled: !!agentId && !!file,
    staleTime: 10_000,
  })
}

export function useGitLog(wsUrl: string, agentId: string | null, limit: number, offset: number) {
  const queryKey = `git:log:${agentId ?? ''}:${limit}:${offset}`
  const fetchFn = useCallback(
    () => fetchGitApi<GitLogResult>(wsUrl, '/api/git/log', {
      agentId: agentId!,
      limit: String(limit),
      offset: String(offset),
    }),
    [wsUrl, agentId, limit, offset],
  )

  return useSimpleQuery<GitLogResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 60_000,
  })
}

export function useGitCommitDetail(wsUrl: string, agentId: string | null, sha: string | null) {
  const queryKey = `git:commit:${agentId ?? ''}:${sha ?? ''}`
  const fetchFn = useCallback(
    () => fetchGitApi<GitCommitDetail>(wsUrl, '/api/git/commit', { agentId: agentId!, sha: sha! }),
    [wsUrl, agentId, sha],
  )

  return useSimpleQuery<GitCommitDetail>(queryKey, fetchFn, {
    enabled: !!agentId && !!sha,
    staleTime: Number.MAX_SAFE_INTEGER, // committed data never changes
  })
}

export function useGitCommitFileDiff(wsUrl: string, agentId: string | null, sha: string | null, file: string | null) {
  const queryKey = `git:commit-diff:${agentId ?? ''}:${sha ?? ''}:${file ?? ''}`
  const fetchFn = useCallback(
    () => fetchGitApi<GitDiffResult>(wsUrl, '/api/git/commit-diff', {
      agentId: agentId!,
      sha: sha!,
      file: file!,
    }),
    [wsUrl, agentId, sha, file],
  )

  return useSimpleQuery<GitDiffResult>(queryKey, fetchFn, {
    enabled: !!agentId && !!sha && !!file,
    staleTime: Number.MAX_SAFE_INTEGER,
  })
}

/** Invalidate all git caches (call on manual refresh) */
export function invalidateGitCaches() {
  for (const key of queryCache.keys()) {
    if (
      key.startsWith('git:status:') ||
      key.startsWith('git:diff:') ||
      key.startsWith('git:log:')
    ) {
      queryCache.delete(key)
    }
  }
  // Note: git:commit: and git:commit-diff: caches are NOT invalidated
  // because committed data is immutable.
}
