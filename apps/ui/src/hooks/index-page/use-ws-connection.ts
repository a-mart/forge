import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import {
  createInitialManagerWsState,
  type ManagerWsState,
} from '@/lib/ws-state'

export function useWsConnection(wsUrl: string): {
  clientRef: MutableRefObject<ManagerWsClient | null>
  state: ManagerWsState
  setState: Dispatch<SetStateAction<ManagerWsState>>
} {
  const clientRef = useRef<ManagerWsClient | null>(null)
  const [state, setState] = useState<ManagerWsState>(() =>
    createInitialManagerWsState(null),
  )

  useEffect(() => {
    const client = new ManagerWsClient(wsUrl)
    clientRef.current = client
    setState(client.getState())

    const unsubscribe = client.subscribe((nextState) => {
      setState(nextState)
    })

    client.start()

    return () => {
      unsubscribe()
      if (clientRef.current === client) {
        clientRef.current = null
      }
      client.destroy()
    }
  }, [wsUrl])

  return {
    clientRef,
    state,
    setState,
  }
}
