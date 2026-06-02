import {
  fetchCodexCatalog,
  type CodexCatalogFetchResult,
  type CodexCatalogSnapshot,
} from './codex-catalog-api'

const CACHE_TTL_MS = 30_000

type CacheEntry = {
  snapshot: CodexCatalogSnapshot
  fetchedAtMs: number
  inflight?: Promise<CodexCatalogFetchResult>
}

const cacheByManager = new Map<string, CacheEntry>()

function emptySnapshot(): CodexCatalogSnapshot {
  return {
    apps: [],
    plugins: [],
    tools: [],
    fetchedAt: new Date(0).toISOString(),
  }
}

function hasCachedSnapshot(entry: CacheEntry | undefined): entry is CacheEntry {
  return entry !== undefined && entry.fetchedAtMs > 0
}

export function clearCodexCatalogCache(managerAgentId?: string): void {
  if (managerAgentId) {
    cacheByManager.delete(managerAgentId)
    return
  }

  cacheByManager.clear()
}

export function getCachedCodexCatalog(managerAgentId: string): CodexCatalogSnapshot | null {
  const entry = cacheByManager.get(managerAgentId)
  return hasCachedSnapshot(entry) ? entry.snapshot : null
}

export function isCodexCatalogCacheFresh(managerAgentId: string, nowMs = Date.now()): boolean {
  const entry = cacheByManager.get(managerAgentId)
  if (!hasCachedSnapshot(entry)) {
    return false
  }

  return nowMs - entry.fetchedAtMs <= CACHE_TTL_MS
}

function storeSnapshot(managerAgentId: string, snapshot: CodexCatalogSnapshot): void {
  const existing = cacheByManager.get(managerAgentId)
  cacheByManager.set(managerAgentId, {
    snapshot,
    fetchedAtMs: Date.now(),
    inflight: existing?.inflight,
  })
}

/** Non-blocking warm-up for composer sessions; errors keep any stale cache. */
export function ensureCodexCatalogWarm(
  wsUrl: string | undefined,
  managerAgentId: string,
): void {
  if (!managerAgentId || isCodexCatalogCacheFresh(managerAgentId)) {
    return
  }

  void fetchCodexCatalogWithCache(wsUrl, managerAgentId).catch(() => {
    // Warm-up is best-effort; picker handles explicit fetch errors.
  })
}

export async function fetchCodexCatalogWithCache(
  wsUrl: string | undefined,
  managerAgentId: string,
  options?: { forceRefresh?: boolean },
): Promise<CodexCatalogFetchResult> {
  const existing = cacheByManager.get(managerAgentId)
  const forceRefresh = options?.forceRefresh === true

  if (!forceRefresh && existing?.inflight) {
    return existing.inflight
  }

  if (!forceRefresh && hasCachedSnapshot(existing) && isCodexCatalogCacheFresh(managerAgentId)) {
    return { status: 'ok', snapshot: existing.snapshot }
  }

  const inflight: Promise<CodexCatalogFetchResult> = fetchCodexCatalog(
    wsUrl,
    managerAgentId,
  ).then((result): CodexCatalogFetchResult => {
    const entry = cacheByManager.get(managerAgentId)
    if (entry?.inflight === inflight) {
      entry.inflight = undefined
    }

    if (result.status === 'ok') {
      storeSnapshot(managerAgentId, result.snapshot)
      return result
    }

    if (hasCachedSnapshot(entry)) {
      return { status: 'ok', snapshot: entry.snapshot }
    }

    return result
  })

  if (existing) {
    existing.inflight = inflight
    return inflight
  }

  cacheByManager.set(managerAgentId, {
    snapshot: emptySnapshot(),
    fetchedAtMs: 0,
    inflight,
  })

  return inflight
}
