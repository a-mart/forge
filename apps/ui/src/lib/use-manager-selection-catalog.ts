import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ManagerSelectionCatalogResponse } from '@forge/protocol'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { createBuilderSettingsApiClient } from '@/components/settings/settings-api-client'
import { fetchManagerSelectionCatalog } from '@/lib/manager-selection-catalog-api'

interface CatalogCacheEntry {
  catalog?: ManagerSelectionCatalogResponse
  cacheToken?: string
  inflight?: {
    cacheToken: string
    promise: Promise<ManagerSelectionCatalogResponse>
  }
}

const queryCache = new Map<string, CatalogCacheEntry>()
const LOCAL_FIRST_CATALOG_ERROR = 'Failed to load models.'

export function managerSelectionCatalogQueryKey(originId: string): string {
  return `manager-selection-catalog:${originId}`
}

export function invalidateManagerSelectionCatalog(originId?: string): void {
  if (originId) {
    queryCache.delete(managerSelectionCatalogQueryKey(originId))
    return
  }
  queryCache.clear()
}

function resolveClient(
  clientOrWsUrl: SettingsApiClient | string | undefined,
  httpClientRef?: RefObject<SettingsApiClient | null>,
): SettingsApiClient | null {
  if (httpClientRef) return httpClientRef.current
  if (typeof clientOrWsUrl === 'string' || clientOrWsUrl === undefined) {
    return createBuilderSettingsApiClient(clientOrWsUrl ?? '')
  }
  return clientOrWsUrl
}

function cachedCatalog(queryKey: string, cacheToken: string): ManagerSelectionCatalogResponse | null {
  const entry = queryCache.get(queryKey)
  return entry?.cacheToken === cacheToken ? entry.catalog ?? null : null
}

function requestCatalog(
  queryKey: string,
  cacheToken: string,
  client: SettingsApiClient,
  force: boolean,
): Promise<ManagerSelectionCatalogResponse> {
  let entry = queryCache.get(queryKey)
  if (!entry) {
    entry = {}
    queryCache.set(queryKey, entry)
  }

  if (!force && entry.cacheToken === cacheToken && entry.catalog) {
    return Promise.resolve(entry.catalog)
  }
  if (!force && entry.inflight?.cacheToken === cacheToken) {
    return entry.inflight.promise
  }

  const promise = fetchManagerSelectionCatalog(client).then((catalog) => {
    if (queryCache.get(queryKey) === entry && entry.inflight?.promise === promise) {
      entry.catalog = catalog
      entry.cacheToken = cacheToken
    }
    return catalog
  }).finally(() => {
    if (queryCache.get(queryKey) === entry && entry.inflight?.promise === promise) {
      entry.inflight = undefined
    }
  })
  entry.inflight = { cacheToken, promise }
  return promise
}

export interface UseManagerSelectionCatalogOptions {
  originId: string
  enabled?: boolean
  client?: SettingsApiClient | string
  httpClientRef?: RefObject<SettingsApiClient | null>
  /** Bump from `model_config_changed` so the catalog fetch refreshes. */
  modelConfigChangeKey?: number
  /** Bump from transport reconnect so a new server projection is fetched. */
  connectionEpoch?: number
  /** Force a validated fetch when the selector becomes enabled, even if cached. */
  forceOnEnabled?: boolean
}

export interface ManagerSelectionCatalogQuery {
  catalog: ManagerSelectionCatalogResponse | null
  loading: boolean
  error: string | null
  refetch: (force?: boolean) => void
}

export function useManagerSelectionCatalog(
  options: UseManagerSelectionCatalogOptions,
): ManagerSelectionCatalogQuery {
  const {
    originId,
    enabled = true,
    client,
    httpClientRef,
    modelConfigChangeKey,
    connectionEpoch,
    forceOnEnabled = false,
  } = options
  const queryKey = managerSelectionCatalogQueryKey(originId)
  const cacheToken = useMemo(
    () => JSON.stringify([modelConfigChangeKey ?? null, connectionEpoch ?? null]),
    [connectionEpoch, modelConfigChangeKey],
  )
  const [catalog, setCatalog] = useState<ManagerSelectionCatalogResponse | null>(
    () => cachedCatalog(queryKey, cacheToken),
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRevisionRef = useRef(0)

  const loadCatalog = useCallback((force = false) => {
    if (!enabled) return

    const cached = !force ? cachedCatalog(queryKey, cacheToken) : null
    if (cached) {
      setCatalog(cached)
      setLoading(false)
      setError(null)
      return
    }

    const apiClient = resolveClient(client, httpClientRef)
    if (!apiClient) {
      setLoading(false)
      setError('Model settings are unavailable.')
      return
    }

    const revision = ++loadRevisionRef.current
    setLoading(true)
    setError(null)
    void requestCatalog(queryKey, cacheToken, apiClient, force)
      .then((data) => {
        if (loadRevisionRef.current !== revision) return
        setCatalog(data)
      })
      .catch((loadError) => {
        if (loadRevisionRef.current !== revision) return
        setError(loadError instanceof Error ? loadError.message : LOCAL_FIRST_CATALOG_ERROR)
      })
      .finally(() => {
        if (loadRevisionRef.current === revision) setLoading(false)
      })
  }, [cacheToken, client, enabled, httpClientRef, queryKey])

  useEffect(() => {
    loadRevisionRef.current += 1
    setCatalog(cachedCatalog(queryKey, cacheToken))
    setError(null)
    if (!enabled) {
      setLoading(false)
      return
    }
    loadCatalog(forceOnEnabled)
    return () => {
      loadRevisionRef.current += 1
    }
  }, [cacheToken, enabled, forceOnEnabled, loadCatalog, queryKey])

  const refetch = useCallback((force = true) => {
    loadCatalog(force)
  }, [loadCatalog])

  return { catalog, loading, error, refetch }
}
