import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FileContentResult,
  FileCountResult,
  FileListResult,
  FileSaveRequest,
  FileSaveResponse,
  FileSaveSuccessResponse,
  FileSearchResult,
  FileVersionToken,
  ProjectResourceMutationResponse,
  ProjectResourcesSnapshotResponse,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { invalidateGitCaches } from '@/components/diff-viewer/use-diff-queries'

export type {
  FileContentResult,
  FileListResult,
  FileSaveRequest,
  FileSaveResponse,
  FileSaveSuccessResponse,
  FileVersionToken,
  ProjectResourcesSnapshotResponse,
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
  return fetchJson<T>(wsUrl, `${path}?${searchParams.toString()}`)
}

function buildFileBrowserParams(
  agentId: string,
  extraParams: Record<string, string> = {},
  worktreeId?: string | null,
): Record<string, string> {
  const params: Record<string, string> = {
    agentId,
    ...extraParams,
  }

  if (worktreeId) {
    params.worktreeId = worktreeId
  }

  return params
}

function buildFileBrowserQueryKey(
  scope: string,
  agentId: string | null,
  worktreeId: string | null | undefined,
  ...parts: string[]
): string {
  return `${scope}:${agentId ?? ''}:${worktreeId ?? ''}:${parts.join(':')}`
}

async function fetchJson<T>(
  wsUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = resolveApiEndpoint(wsUrl, path)
  const response = await fetch(url, init)

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }

  return response.json() as Promise<T>
}

const FILE_SAVE_CONFLICT_REASONS = new Set([
  'modified',
  'deleted',
  'not_file',
  'binary',
  'too_large',
  'unsupported_encoding',
])

function isFileVersionToken(value: unknown): value is FileVersionToken {
  if (!value || typeof value !== 'object') return false
  const token = value as Partial<FileVersionToken>
  return token.kind === 'sha256-stat-v1' &&
    typeof token.sha256 === 'string' &&
    token.sha256.length > 0 &&
    typeof token.size === 'number' &&
    Number.isFinite(token.size) &&
    typeof token.mtimeMs === 'number' &&
    Number.isFinite(token.mtimeMs)
}

function isFileSaveResponse(value: unknown): value is FileSaveResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<FileSaveResponse>

  if (response.success === true) {
    return isFileVersionToken(response.version) &&
      typeof response.size === 'number' &&
      Number.isFinite(response.size) &&
      typeof response.lines === 'number' &&
      Number.isFinite(response.lines) &&
      typeof response.bytesWritten === 'number' &&
      Number.isFinite(response.bytesWritten)
  }

  if (response.success === false) {
    return response.conflict === true &&
      typeof response.reason === 'string' &&
      FILE_SAVE_CONFLICT_REASONS.has(response.reason) &&
      (response.currentVersion === undefined || isFileVersionToken(response.currentVersion)) &&
      (response.currentSize === undefined || (typeof response.currentSize === 'number' && Number.isFinite(response.currentSize)))
  }

  return false
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function getResponseErrorMessage(payload: unknown, response: Response): string {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'string' && error.trim().length > 0) {
      return error
    }
  }

  return response.statusText || `HTTP ${response.status}`
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
  const [dataState, setDataState] = useState<{ queryKey: string; data: T | null }>(() => {
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      return { queryKey, data: cached.data as T }
    }
    return { queryKey, data: null }
  })
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchKeyRef = useRef(0)

  // Reset state when queryKey changes to prevent stale data flash.
  // Uses an effect rather than render-time state reset to keep render pure;
  // the returned value is additionally keyed below so stale data is hidden
  // synchronously during the first render after a key change.
  useEffect(() => {
    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setDataState({ queryKey, data: cached.data as T })
    } else {
      setDataState({ queryKey, data: null })
    }
    setError(null)
  }, [queryKey, options.staleTime])

  const doFetch = useCallback(() => {
    if (!options.enabled) {
      setError(null)
      return
    }

    const cached = queryCache.get(queryKey)
    if (cached && Date.now() - cached.fetchedAt < options.staleTime) {
      setDataState({ queryKey, data: cached.data as T })
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
        setDataState({ queryKey, data: result })
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

  const data = dataState.queryKey === queryKey ? dataState.data : null

  return { data, isLoading: isLoading && !data, error, refetch }
}

/* ------------------------------------------------------------------ */
/*  Public hooks                                                       */
/* ------------------------------------------------------------------ */

export function useDirectoryListing(
  wsUrl: string,
  agentId: string | null,
  dirPath: string,
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:list', agentId, worktreeId, dirPath)
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileListResult>(
        wsUrl,
        '/api/files/list',
        buildFileBrowserParams(agentId!, { path: dirPath }, worktreeId),
      ),
    [wsUrl, agentId, dirPath, worktreeId],
  )

  return useSimpleQuery<FileListResult>(queryKey, fetchFn, {
    enabled: !!agentId,
    staleTime: 30_000,
  })
}

export function useFileCount(
  wsUrl: string,
  agentId: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:count', agentId, worktreeId)
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileCountResult>(
        wsUrl,
        '/api/files/count',
        buildFileBrowserParams(agentId!, {}, worktreeId),
      ),
    [wsUrl, agentId, worktreeId],
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
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:search', agentId, worktreeId, query, String(limit))
  const fetchFn = useCallback(
    () =>
      fetchFileBrowserApi<FileSearchResult>(
        wsUrl,
        '/api/files/search',
        buildFileBrowserParams(
          agentId!,
          {
            query,
            limit: String(limit),
          },
          worktreeId,
        ),
      ),
    [wsUrl, agentId, query, limit, worktreeId],
  )

  return useSimpleQuery<FileSearchResult>(queryKey, fetchFn, {
    enabled: !!agentId && query.trim().length >= 2,
    staleTime: 30_000,
  })
}

export function useProjectResourcesSnapshot(
  wsUrl: string,
  params: { profileId: string | null; sessionAgentId: string | null },
) {
  const queryKey = `project-resources:${params.profileId ?? ''}:${params.sessionAgentId ?? ''}`
  const fetchFn = useCallback(
    () => {
      const search = new URLSearchParams({
        profileId: params.profileId!,
        sessionAgentId: params.sessionAgentId!,
      })
      return fetchJson<ProjectResourcesSnapshotResponse>(wsUrl, `/api/settings/project-resources?${search.toString()}`)
    },
    [wsUrl, params.profileId, params.sessionAgentId],
  )

  return useSimpleQuery<ProjectResourcesSnapshotResponse>(queryKey, fetchFn, {
    enabled: !!params.profileId && !!params.sessionAgentId,
    staleTime: 30_000,
  })
}

export function seedProjectResources(
  wsUrl: string,
  params: { profileId: string; sessionAgentId: string },
): Promise<ProjectResourceMutationResponse> {
  return fetchJson<ProjectResourceMutationResponse>(wsUrl, '/api/settings/project-resources/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
}

export async function saveFileContent(
  wsUrl: string,
  request: FileSaveRequest,
): Promise<FileSaveResponse> {
  const url = resolveApiEndpoint(wsUrl, '/api/files/content')
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })

  const payload = await parseResponseJson(response)

  if (response.status === 200 || response.status === 409) {
    if (!isFileSaveResponse(payload)) {
      throw new Error(`Malformed file save response (HTTP ${response.status})`)
    }

    if (response.status === 200 && payload.success === true) {
      return payload
    }

    if (response.status === 409 && payload.success === false && payload.conflict === true) {
      return payload
    }

    throw new Error(`Malformed file save response (HTTP ${response.status})`)
  }

  if (!response.ok) {
    throw new Error(getResponseErrorMessage(payload, response))
  }

  throw new Error(`Unexpected file save status ${response.status}`)
}

export interface ApplySuccessfulFileSaveOptions {
  agentId: string
  worktreeId?: string | null
  filePath: string
  previousContent: FileContentResult | null
  draftContent: string
  saveResponse: FileSaveSuccessResponse
}

export interface FileSaveRefreshTargets {
  content: true
  sidebar: true
  tree: true
  sourceControl: true
}

export interface ApplySuccessfulFileSaveResult {
  content: FileContentResult
  refresh: FileSaveRefreshTargets
}

export function applySuccessfulFileSaveToCaches({
  agentId,
  worktreeId = null,
  filePath,
  previousContent,
  draftContent,
  saveResponse,
}: ApplySuccessfulFileSaveOptions): ApplySuccessfulFileSaveResult {
  const nextContent: FileContentResult = {
    ...(previousContent ?? {}),
    content: draftContent,
    binary: false,
    size: saveResponse.size,
    lines: saveResponse.lines,
    encoding: 'utf8',
    version: saveResponse.version,
    editability: previousContent?.editability
      ? { ...previousContent.editability, editable: true }
      : undefined,
  }

  setFileContentCache(agentId, worktreeId, filePath, nextContent)
  invalidateFileBrowserMetadataCaches()
  invalidateGitCaches({ agentId, repoTarget: 'workspace' })

  return {
    content: nextContent,
    refresh: {
      content: true,
      sidebar: true,
      tree: true,
      sourceControl: true,
    },
  }
}

export function useFileContent(
  wsUrl: string,
  agentId: string | null,
  filePath: string | null,
  worktreeId?: string | null,
) {
  const queryKey = buildFileBrowserQueryKey('files:content', agentId, worktreeId, filePath ?? '')
  const fetchFn = useCallback(
    () => fetchFileContent(wsUrl, agentId!, filePath!, worktreeId),
    [wsUrl, agentId, filePath, worktreeId],
  )

  return useSimpleQuery<FileContentResult>(queryKey, fetchFn, {
    enabled: !!agentId && !!filePath,
    staleTime: 30_000,
  })
}

export async function fetchFileContent(
  wsUrl: string,
  agentId: string,
  filePath: string,
  worktreeId?: string | null,
): Promise<FileContentResult> {
  return fetchFileBrowserApi<FileContentResult>(
    wsUrl,
    '/api/files/content',
    buildFileBrowserParams(agentId, { path: filePath }, worktreeId),
  )
}

export function setFileContentCache(
  agentId: string,
  worktreeId: string | null | undefined,
  filePath: string,
  content: FileContentResult,
) {
  const queryKey = buildFileBrowserQueryKey('files:content', agentId, worktreeId, filePath)
  queryCache.set(queryKey, { data: content, fetchedAt: Date.now() })
  evictOldestCacheEntries()
}

export function invalidateFileContentCache(
  agentId: string | null,
  worktreeId: string | null | undefined,
  filePath: string | null,
) {
  if (!agentId || !filePath) return
  queryCache.delete(buildFileBrowserQueryKey('files:content', agentId, worktreeId, filePath))
}

export function invalidateFileBrowserMetadataCaches() {
  for (const key of queryCache.keys()) {
    if (key.startsWith('files:list') || key.startsWith('files:count') || key.startsWith('files:search')) {
      queryCache.delete(key)
    }
  }
}

/** Invalidate all file browser caches (call on manual refresh) */
export function invalidateFileBrowserCaches() {
  for (const key of queryCache.keys()) {
    if (key.startsWith('files:') || key.startsWith('project-resources:')) {
      queryCache.delete(key)
    }
  }
}
