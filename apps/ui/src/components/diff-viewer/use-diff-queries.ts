import type {
  GitBranchListResult,
  GitCommitDetail,
  GitCreateBranchRequest,
  GitDiffResult,
  GitFetchRequest,
  GitFetchResult,
  GitHostedProviderStatus,
  GitLogResult,
  GitMutationResult,
  GitPullFfOnlyRequest,
  GitPullRequestDetail,
  GitPullRequestListResult,
  GitPullResult,
  GitRepoTarget,
  GitStatusResult,
  GitSwitchBranchRequest,
  GitWorktreeListResult,
} from '@forge/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

export type GitPullRequestsQueryResult = ReturnType<typeof useGitPullRequests>

export type {
  GitBranchListResult,
  GitCommitDetail,
  GitDiffResult,
  GitFileStatus,
  GitLogEntry,
  GitLogResult,
  GitRepoTarget,
  GitStatusResult,
  GitWorktreeListResult,
} from '@forge/protocol'

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

async function postGitApi<T>(wsUrl: string, path: string, body: object): Promise<T> {
  const url = resolveApiEndpoint(wsUrl, path)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const payload = await response.json().catch(() => ({ error: response.statusText })) as T & {
    error?: string
    success?: boolean
    errors?: string[]
  }

  if (!response.ok && typeof payload.error === 'string') {
    throw new Error(payload.error)
  }

  return payload as T
}

function buildGitRequestParams(
  agentId: string,
  repoTarget: GitRepoTarget,
  extraParams: Record<string, string | number | null | undefined> = {},
  worktreeId?: string | null,
): Record<string, string> {
  const params: Record<string, string> = {
    agentId,
    repoTarget,
  }

  if (worktreeId) {
    params.worktreeId = worktreeId
  }

  for (const [key, value] of Object.entries(extraParams)) {
    if (value == null) continue
    params[key] = String(value)
  }

  return params
}

function buildGitQueryKey(
  scope: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  ...parts: Array<string | number | null>
): string {
  return JSON.stringify([scope, agentId ?? '', repoTarget, worktreeId ?? '', ...parts.map((part) => part ?? '')])
}

function parseGitQueryKey(
  queryKey: string,
): { scope: string; agentId: string; repoTarget: GitRepoTarget } | null {
  try {
    const parsed = JSON.parse(queryKey)
    if (!Array.isArray(parsed) || parsed.length < 3) {
      return null
    }

    const [scope, agentId, repoTarget] = parsed
    if (typeof scope !== 'string' || typeof agentId !== 'string') {
      return null
    }
    if (repoTarget !== 'workspace' && repoTarget !== 'versioning') {
      return null
    }

    return { scope, agentId, repoTarget }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  Lightweight query hook (replaces TanStack Query for this module)  */
/*  Follows the same staleTime / refetchOnWindowFocus semantics       */
/* ------------------------------------------------------------------ */

export interface QueryResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export type GitWorktreesQueryResult = QueryResult<GitWorktreeListResult>
export type GitBranchesQueryResult = QueryResult<GitBranchListResult>

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

  useEffect(() => {
    if (!options.enabled) {
      setData(null)
      setError(null)
      setIsLoading(false)
      return
    }

    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setData(cached.data as T)
      setError(null)
      setIsLoading(false)
      return
    }

    setData(null)
    setError(null)
  }, [queryKey, options.enabled, options.staleTime])

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
        setData(null)
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

export function useGitStatus(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:status', agentId, repoTarget, worktreeId)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitStatusResult>(
        wsUrl,
        '/api/git/status',
        buildGitRequestParams(agentId!, repoTarget, {}, worktreeId),
      ),
    [wsUrl, agentId, repoTarget, worktreeId],
  )

  return useSimpleQuery<GitStatusResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitBranches(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const queryKey = buildGitQueryKey('git:branches', agentId, repoTarget, worktreeId)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitBranchListResult>(
        wsUrl,
        '/api/git/branches',
        buildGitRequestParams(agentId!, repoTarget, {}, worktreeId),
      ),
    [wsUrl, agentId, repoTarget, worktreeId],
  )

  return useSimpleQuery<GitBranchListResult>(queryKey, fetchFn, {
    enabled: enabled && !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitWorktrees(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const queryKey = buildGitQueryKey('git:worktrees', agentId, repoTarget, null)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitWorktreeListResult>(
        wsUrl,
        '/api/git/worktrees',
        buildGitRequestParams(agentId!, repoTarget),
      ),
    [wsUrl, agentId, repoTarget],
  )

  return useSimpleQuery<GitWorktreeListResult>(queryKey, fetchFn, {
    enabled: enabled && !!agentId,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitProviderStatus(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const queryKey = buildGitQueryKey('git:provider-status', agentId, repoTarget, worktreeId)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitHostedProviderStatus>(
        wsUrl,
        '/api/git/provider/status',
        buildGitRequestParams(agentId!, repoTarget, {}, worktreeId),
      ),
    [wsUrl, agentId, repoTarget, worktreeId],
  )

  return useSimpleQuery<GitHostedProviderStatus>(queryKey, fetchFn, {
    enabled: enabled && !!agentId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitPullRequests(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  worktreeId?: string | null,
  options: { enabled?: boolean; closedLimit?: number } = {},
) {
  const enabled = options.enabled ?? !!agentId
  const queryKey = buildGitQueryKey(
    'git:pull-requests',
    agentId,
    repoTarget,
    worktreeId,
    options.closedLimit ?? 10,
  )
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitPullRequestListResult>(
        wsUrl,
        '/api/git/pull-requests',
        buildGitRequestParams(
          agentId!,
          repoTarget,
          { closedLimit: options.closedLimit ?? 10 },
          worktreeId,
        ),
      ),
    [wsUrl, agentId, repoTarget, worktreeId, options.closedLimit],
  )

  return useSimpleQuery<GitPullRequestListResult>(queryKey, fetchFn, {
    enabled: enabled && !!agentId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitPullRequestDetail(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  number: number | null,
  worktreeId?: string | null,
  options: { enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? !!agentId) && number != null
  const queryKey = buildGitQueryKey('git:pull-request-detail', agentId, repoTarget, worktreeId, number)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitPullRequestDetail>(
        wsUrl,
        `/api/git/pull-requests/${number}`,
        buildGitRequestParams(agentId!, repoTarget, {}, worktreeId),
      ),
    [wsUrl, agentId, repoTarget, number, worktreeId],
  )

  return useSimpleQuery<GitPullRequestDetail>(queryKey, fetchFn, {
    enabled: enabled && !!agentId && number != null,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  })
}

export function useGitDiff(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  file: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:diff', agentId, repoTarget, worktreeId, file)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitDiffResult>(
        wsUrl,
        '/api/git/diff',
        buildGitRequestParams(agentId!, repoTarget, { file: file! }, worktreeId),
      ),
    [wsUrl, agentId, repoTarget, file, worktreeId],
  )

  return useSimpleQuery<GitDiffResult>(queryKey, fetchFn, {
    enabled: !!agentId && !!file,
    staleTime: 10_000,
  })
}

export function useGitLog(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  limit: number,
  offset: number,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:log', agentId, repoTarget, worktreeId, limit, offset)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitLogResult>(
        wsUrl,
        '/api/git/log',
        buildGitRequestParams(
          agentId!,
          repoTarget,
          {
            limit,
            offset,
          },
          worktreeId,
        ),
      ),
    [wsUrl, agentId, repoTarget, limit, offset, worktreeId],
  )

  return useSimpleQuery<GitLogResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 60_000,
  })
}

export function useGitCommitDetail(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  sha: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:commit', agentId, repoTarget, worktreeId, sha)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitCommitDetail>(
        wsUrl,
        '/api/git/commit',
        buildGitRequestParams(agentId!, repoTarget, { sha: sha! }, worktreeId),
      ),
    [wsUrl, agentId, repoTarget, sha, worktreeId],
  )

  return useSimpleQuery<GitCommitDetail>(queryKey, fetchFn, {
    enabled: !!agentId && !!sha,
    staleTime: Number.MAX_SAFE_INTEGER, // committed data never changes
  })
}

export function useGitCommitDiff(
  wsUrl: string,
  agentId: string | null,
  repoTarget: GitRepoTarget,
  sha: string | null,
  file: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildGitQueryKey('git:commit-diff', agentId, repoTarget, worktreeId, sha, file)
  const fetchFn = useCallback(
    () =>
      fetchGitApi<GitDiffResult>(
        wsUrl,
        '/api/git/commit-diff',
        buildGitRequestParams(
          agentId!,
          repoTarget,
          {
            sha: sha!,
            file: file!,
          },
          worktreeId,
        ),
      ),
    [wsUrl, agentId, repoTarget, sha, file, worktreeId],
  )

  return useSimpleQuery<GitDiffResult>(queryKey, fetchFn, {
    enabled: !!agentId && !!sha && !!file,
    staleTime: Number.MAX_SAFE_INTEGER,
  })
}

export async function fetchGitOrigin(
  wsUrl: string,
  request: GitFetchRequest,
): Promise<GitFetchResult> {
  return postGitApi<GitFetchResult>(wsUrl, '/api/git/fetch', request)
}

export async function switchGitBranch(
  wsUrl: string,
  request: GitSwitchBranchRequest,
): Promise<GitMutationResult> {
  return postGitApi<GitMutationResult>(wsUrl, '/api/git/switch-branch', request)
}

export async function createGitBranch(
  wsUrl: string,
  request: GitCreateBranchRequest,
): Promise<GitMutationResult> {
  return postGitApi<GitMutationResult>(wsUrl, '/api/git/create-branch', request)
}

export async function pullGitFfOnly(
  wsUrl: string,
  request: GitPullFfOnlyRequest,
): Promise<GitPullResult> {
  return postGitApi<GitPullResult>(wsUrl, '/api/git/pull-ff-only', request)
}

/** Invalidate mutable git caches. Commit caches remain immutable. */
export function invalidateGitCaches(options?: { agentId?: string | null; repoTarget?: GitRepoTarget }) {
  for (const key of queryCache.keys()) {
    const parsed = parseGitQueryKey(key)
    if (!parsed) {
      continue
    }

    if (
      parsed.scope !== 'git:status' &&
      parsed.scope !== 'git:branches' &&
      parsed.scope !== 'git:worktrees' &&
      parsed.scope !== 'git:pull-requests' &&
      parsed.scope !== 'git:provider-status' &&
      parsed.scope !== 'git:pull-request-detail' &&
      parsed.scope !== 'git:diff' &&
      parsed.scope !== 'git:log'
    ) {
      continue
    }

    if (options?.agentId != null && parsed.agentId !== options.agentId) {
      continue
    }

    if (options?.repoTarget != null && parsed.repoTarget !== options.repoTarget) {
      continue
    }

    queryCache.delete(key)
  }
}
