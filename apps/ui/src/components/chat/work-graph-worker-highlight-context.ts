import { createContext, useContext } from 'react'

export interface WorkerHighlightSignal {
  workerId: string
  nonce: number
}

export interface WorkGraphWorkerHighlightContextValue {
  signal: WorkerHighlightSignal | null
  highlightWorker: (workerId: string | undefined) => void
}

export const WorkGraphWorkerHighlightContext = createContext<WorkGraphWorkerHighlightContextValue>({
  signal: null,
  highlightWorker: () => undefined,
})

export function useWorkGraphWorkerHighlight(): WorkGraphWorkerHighlightContextValue {
  return useContext(WorkGraphWorkerHighlightContext)
}
