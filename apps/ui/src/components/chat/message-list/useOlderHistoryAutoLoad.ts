import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_MINIMUM_LOAD_INTERVAL_MS = 750
const TOP_PREFETCH_MARGIN_PX = 400

type ObserverSupport = 'unknown' | 'supported' | 'unsupported'

interface UseOlderHistoryAutoLoadOptions {
  activeAgentId?: string | null
  cursor?: string
  hasOlder: boolean
  isLoading: boolean
  historyCompleteness: 'complete' | 'partial_scan' | 'source_changed'
  scrollRoot: HTMLElement | null
  onBeforeLoad: () => void
  onLoad?: () => unknown | Promise<unknown>
  minimumLoadIntervalMs?: number
}

interface UseOlderHistoryAutoLoadResult {
  sentinelRef: (element: HTMLDivElement | null) => void
  observerSupported: boolean
  loadFailed: boolean
  loadManually: () => void
}

function buildPageKey(activeAgentId: string | null | undefined, cursor: string | undefined) {
  if (!activeAgentId || !cursor) return null
  return `${activeAgentId}\u0000${cursor}`
}

export function useOlderHistoryAutoLoad({
  activeAgentId,
  cursor,
  hasOlder,
  isLoading,
  historyCompleteness,
  scrollRoot,
  onBeforeLoad,
  onLoad,
  minimumLoadIntervalMs = DEFAULT_MINIMUM_LOAD_INTERVAL_MS,
}: UseOlderHistoryAutoLoadOptions): UseOlderHistoryAutoLoadResult {
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const [observerSupport, setObserverSupport] = useState<ObserverSupport>('unknown')
  const [failedPageKey, setFailedPageKey] = useState<string | null>(null)
  const pageKey = buildPageKey(activeAgentId, cursor)
  const canLoad = Boolean(onLoad)

  const optionsRef = useRef({
    pageKey,
    hasOlder,
    isLoading,
    historyCompleteness,
    onBeforeLoad,
    onLoad,
    minimumLoadIntervalMs,
  })
  useEffect(() => {
    optionsRef.current = {
      pageKey,
      hasOlder,
      isLoading,
      historyCompleteness,
      onBeforeLoad,
      onLoad,
      minimumLoadIntervalMs,
    }
  }, [
    hasOlder,
    historyCompleteness,
    isLoading,
    minimumLoadIntervalMs,
    onBeforeLoad,
    onLoad,
    pageKey,
  ])

  const lastAutomaticallyRequestedPageKeyRef = useRef<string | null>(null)
  const inFlightPageKeyRef = useRef<string | null>(null)
  const lastLoadStartedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const isIntersectingRef = useRef(false)
  const scheduledLoadRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeAgentIdRef = useRef(activeAgentId)
  const sessionLifecycleRef = useRef(0)
  const scheduleAutomaticLoadRef = useRef<(requestedPageKey: string) => void>(() => undefined)

  const clearScheduledLoad = useCallback(() => {
    if (scheduledLoadRef.current !== null) {
      clearTimeout(scheduledLoadRef.current)
      scheduledLoadRef.current = null
    }
  }, [])

  const startLoad = useCallback((requestedPageKey: string, automatic: boolean) => {
    const current = optionsRef.current
    if (
      current.pageKey !== requestedPageKey ||
      !current.hasOlder ||
      current.isLoading ||
      current.historyCompleteness === 'source_changed' ||
      !current.onLoad ||
      inFlightPageKeyRef.current !== null
    ) {
      return
    }
    if (
      automatic &&
      lastAutomaticallyRequestedPageKeyRef.current === requestedPageKey
    ) {
      return
    }

    if (automatic) {
      lastAutomaticallyRequestedPageKeyRef.current = requestedPageKey
    }
    inFlightPageKeyRef.current = requestedPageKey
    const requestedSessionLifecycle = sessionLifecycleRef.current
    lastLoadStartedAtRef.current = Date.now()
    setFailedPageKey((failed) => failed === requestedPageKey ? null : failed)
    current.onBeforeLoad()

    let result: unknown | Promise<unknown>
    try {
      result = current.onLoad()
    } catch (error) {
      result = Promise.reject(error)
    }

    void Promise.resolve(result)
      .catch(() => {
        if (
          optionsRef.current.pageKey === requestedPageKey &&
          sessionLifecycleRef.current === requestedSessionLifecycle
        ) {
          setFailedPageKey(requestedPageKey)
        }
      })
      .finally(() => {
        if (inFlightPageKeyRef.current !== requestedPageKey) return

        inFlightPageKeyRef.current = null
        const currentPageKey = optionsRef.current.pageKey
        if (isIntersectingRef.current && currentPageKey) {
          scheduleAutomaticLoadRef.current(currentPageKey)
        }
      })
  }, [])

  const scheduleAutomaticLoad = useCallback((requestedPageKey: string) => {
    const current = optionsRef.current
    if (
      current.pageKey !== requestedPageKey ||
      current.isLoading ||
      failedPageKey === requestedPageKey ||
      lastAutomaticallyRequestedPageKeyRef.current === requestedPageKey ||
      inFlightPageKeyRef.current !== null ||
      scheduledLoadRef.current !== null
    ) {
      return
    }

    const elapsed = Date.now() - lastLoadStartedAtRef.current
    const delay = Math.max(0, current.minimumLoadIntervalMs - elapsed)
    if (delay === 0) {
      startLoad(requestedPageKey, true)
      return
    }

    scheduledLoadRef.current = setTimeout(() => {
      scheduledLoadRef.current = null
      if (isIntersectingRef.current && optionsRef.current.pageKey === requestedPageKey) {
        startLoad(requestedPageKey, true)
      }
    }, delay)
  }, [failedPageKey, startLoad])

  useEffect(() => {
    scheduleAutomaticLoadRef.current = scheduleAutomaticLoad
  }, [scheduleAutomaticLoad])

  useEffect(() => {
    if (activeAgentIdRef.current !== activeAgentId) {
      activeAgentIdRef.current = activeAgentId
      sessionLifecycleRef.current += 1
      lastAutomaticallyRequestedPageKeyRef.current = null
    }
    setFailedPageKey((failed) => failed && failed !== pageKey ? null : failed)
    clearScheduledLoad()
    isIntersectingRef.current = false
  }, [activeAgentId, clearScheduledLoad, pageKey])

  useEffect(() => {
    if (!scrollRoot || !sentinel) return

    const ownerWindow = scrollRoot.ownerDocument.defaultView
    const IntersectionObserverConstructor = ownerWindow?.IntersectionObserver
    if (!IntersectionObserverConstructor) {
      setObserverSupport('unsupported')
      return
    }

    setObserverSupport('supported')
    if (!pageKey || !hasOlder || historyCompleteness === 'source_changed' || !canLoad) {
      return
    }

    const observer = new IntersectionObserverConstructor(
      ([entry]) => {
        const isIntersecting = entry?.isIntersecting ?? false
        isIntersectingRef.current = isIntersecting
        if (!isIntersecting) {
          clearScheduledLoad()
          return
        }
        scheduleAutomaticLoad(pageKey)
      },
      {
        root: scrollRoot,
        rootMargin: `${TOP_PREFETCH_MARGIN_PX}px 0px 0px 0px`,
      },
    )
    observer.observe(sentinel)

    return () => {
      observer.disconnect()
      clearScheduledLoad()
      isIntersectingRef.current = false
    }
  }, [
    canLoad,
    clearScheduledLoad,
    hasOlder,
    historyCompleteness,
    pageKey,
    scheduleAutomaticLoad,
    scrollRoot,
    sentinel,
  ])

  useEffect(() => {
    if (!isLoading && isIntersectingRef.current && pageKey) {
      scheduleAutomaticLoad(pageKey)
    }
  }, [isLoading, pageKey, scheduleAutomaticLoad])

  useEffect(() => clearScheduledLoad, [clearScheduledLoad])

  const loadManually = useCallback(() => {
    const currentPageKey = optionsRef.current.pageKey
    if (!currentPageKey) return
    clearScheduledLoad()
    startLoad(currentPageKey, false)
  }, [clearScheduledLoad, startLoad])

  return {
    sentinelRef: setSentinel,
    observerSupported: observerSupport !== 'unsupported',
    loadFailed: Boolean(pageKey && failedPageKey === pageKey),
    loadManually,
  }
}
