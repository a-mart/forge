import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'
import {
  WorkGraphWorkerHighlightContext,
  type WorkerHighlightSignal,
  useWorkGraphWorkerHighlight,
} from './work-graph-worker-highlight-context'

const HIGHLIGHT_DURATION_MS = 900

/** Shares a short-lived visual-only worker highlight across the Builder surface. */
export function WorkGraphWorkerHighlightProvider({ children }: { children: ReactNode }) {
  const [signal, setSignal] = useState<WorkerHighlightSignal | null>(null)
  const nonceRef = useRef(0)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const highlightWorker = useCallback((workerId: string | undefined) => {
    if (!workerId) return

    const nextSignal = { workerId, nonce: ++nonceRef.current }
    setSignal(nextSignal)
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    clearTimerRef.current = setTimeout(() => {
      setSignal((current) => current?.nonce === nextSignal.nonce ? null : current)
    }, HIGHLIGHT_DURATION_MS)
  }, [])

  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
  }, [])

  const value = useMemo(() => ({ signal, highlightWorker }), [highlightWorker, signal])

  return (
    <WorkGraphWorkerHighlightContext.Provider value={value}>
      {children}
    </WorkGraphWorkerHighlightContext.Provider>
  )
}

/**
 * An ephemeral overlay rather than state on either target: this never changes
 * selection, expansion, focus, or scroll position. Its key replays the CSS
 * animation for repeated clicks on the same graph node.
 */
export function WorkerHighlightOutline({
  workerId,
  className,
}: {
  workerId: string
  className?: string
}) {
  const { signal } = useWorkGraphWorkerHighlight()
  if (signal?.workerId !== workerId) return null

  return (
    <span
      key={signal.nonce}
      aria-hidden="true"
      data-work-graph-worker-highlight
      className={cn(
        'pointer-events-none absolute -inset-0.5 z-10 border-2 border-violet-400 work-graph-worker-highlight',
        className,
      )}
    />
  )
}
