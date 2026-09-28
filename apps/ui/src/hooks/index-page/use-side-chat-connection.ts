import { useEffect, useRef, useState } from 'react'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'

/**
 * Panel-scoped Builder connection for a side chat. The origin client tracks a
 * single subscribed conversation (the main chat), so the side chat gets its own
 * short-lived client on the same origin, subscribed to the side chat session.
 */
export function useSideChatConnection({
  wsUrl,
  originId,
  agentId,
}: {
  wsUrl: string
  originId: string
  agentId: string | null
}) {
  const clientRef = useRef<ManagerWsClient | null>(null)
  const [state, setState] = useState<ManagerWsState | null>(null)

  useEffect(() => {
    if (!agentId) {
      setState(null)
      return
    }

    const client = new ManagerWsClient(wsUrl, agentId, { originId })
    clientRef.current = client
    const unsubscribe = client.subscribe(setState)
    client.start()

    return () => {
      unsubscribe()
      if (clientRef.current === client) {
        clientRef.current = null
      }
      client.destroy()
      setState(null)
    }
  }, [agentId, originId, wsUrl])

  return { clientRef, state }
}
