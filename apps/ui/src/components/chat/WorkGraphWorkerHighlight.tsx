import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { WorkGraphNode } from '@forge/protocol'
import { cn } from '@/lib/utils'

const HIGHLIGHT_DURATION_MS = 900

export interface WorkerHighlightSignal {
  workerId: string
  nonce: number
}

interface WorkGraphWorkerHighlightContextValue {
  signal: WorkerHighlightSignal | null
  highlightWorker: (workerId: string | undefined) => void
}

const WorkGraphWorkerHighlightContext = createContext<WorkGraphWorkerHighlightContextValue>({
  signal: null,
  highlightWorker: () => undefined,
})

/**
 * Finds the worker for the node's current attempt. Attempts are append-only, so
 * the final entry is the same attempt the graph coordinator treats as current.
 */
export function getWorkGraphNodeWorkerId(node: WorkGraphNode): string | undefined {
  return node.attempts.at(-1)?.workerId
}

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

export function useWorkGraphWorkerHighlight(): WorkGraphWorkerHighlightContextValue {
  return useContext(WorkGraphWorkerHighlightContext)
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
