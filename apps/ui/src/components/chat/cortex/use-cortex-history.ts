import type { CortexFileReviewHistoryResult, GitFileLogResult } from '@forge/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

interface QueryResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

async function fetchJson<T>(wsUrl: string, path: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const searchParams = new URLSearchParams(params)
  const url = resolveApiEndpoint(wsUrl, `${path}?${searchParams.toString()}`)
  const response = await fetch(url, { signal })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: string }).error === 'string'
        ? (payload as { error: string }).error
        : `Request failed (${response.status})`
    throw new Error(message)
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid response payload.')
  }

  return payload as T
}

function useEndpointQuery<T>(
  enabled: boolean,
  queryKey: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
): QueryResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setData(null)
      setError(null)
      setIsLoading(false)
      return
    }

    const abortController = new AbortController()
    setIsLoading(true)
    setError(null)

    void fetcher(abortController.signal)
      .then((result) => {
        if (abortController.signal.aborted) return
        setData(result)
      })
      .catch((queryError: unknown) => {
        if (abortController.signal.aborted) return
        setData(null)
        setError(queryError instanceof Error ? queryError.message : 'Unknown error')
      })
      .finally(() => {
        if (abortController.signal.aborted) return
        setIsLoading(false)
      })

    return () => {
      abortController.abort()
    }
  }, [enabled, fetcher, queryKey, reloadNonce])

  const refetch = useCallback(() => {
    setReloadNonce((previous) => previous + 1)
  }, [])

  return { data, isLoading, error, refetch }
}

export function useGitFileLog(
  wsUrl: string,
  agentId: string | null | undefined,
  file: string | null | undefined,
  limit = 1,
  offset = 0,
): QueryResult<GitFileLogResult> {
  const normalizedAgentId = agentId?.trim() || null
  const normalizedFile = file?.trim() || null
  const queryKey = useMemo(
    () => JSON.stringify(['cortex', 'git-file-log', wsUrl, normalizedAgentId, normalizedFile, limit, offset]),
    [wsUrl, normalizedAgentId, normalizedFile, limit, offset],
  )
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      fetchJson<GitFileLogResult>(
        wsUrl,
        '/api/git/file-log',
        {
          agentId: normalizedAgentId!,
          repoTarget: 'versioning',
          file: normalizedFile!,
          limit: String(limit),
          offset: String(offset),
        },
        signal,
      ),
    [wsUrl, normalizedAgentId, normalizedFile, limit, offset],
  )

  return useEndpointQuery<GitFileLogResult>(!!normalizedAgentId && !!normalizedFile, queryKey, fetcher)
}

export function useCortexFileReviewHistory(
  wsUrl: string,
  path: string | null | undefined,
  limit = 10,
): QueryResult<CortexFileReviewHistoryResult> {
  const normalizedPath = path?.trim() || null
  const queryKey = useMemo(
    () => JSON.stringify(['cortex', 'file-review-history', wsUrl, normalizedPath, limit]),
    [wsUrl, normalizedPath, limit],
  )
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      fetchJson<CortexFileReviewHistoryResult>(
        wsUrl,
        '/api/cortex/file-review-history',
        {
          path: normalizedPath!,
          limit: String(limit),
        },
        signal,
      ),
    [wsUrl, normalizedPath, limit],
  )

  return useEndpointQuery<CortexFileReviewHistoryResult>(!!normalizedPath, queryKey, fetcher)
}
