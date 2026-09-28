/**
 * Side chat controller: `/side` forks the active Builder session into a
 * temporary, sidebar-hidden `side_chat` session shown in a panel beside the
 * main chat. The backend keeps at most one side chat per source session, so
 * the panel target is derived from the source's descriptor in WS state (which
 * also restores it after a reload). Local state only bridges the fork request
 * until that descriptor arrives, carries the optional first message, and
 * tracks whether the panel is expanded.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { findSideChatForSource } from '@/lib/agent-hierarchy'
import type { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'

interface SideChatForkRequest {
  sourceAgentId: string
  /** Null while the fork is in flight. */
  agentId: string | null
}

export interface SideChatInitialMessage {
  agentId: string
  text: string
}

export interface UseSideChatOptions {
  clientRef: MutableRefObject<ManagerWsClient | null>
  agents: ManagerWsState['agents']
  activeAgentId: string | null
  setState: Dispatch<SetStateAction<ManagerWsState>>
}

export function useSideChat({ clientRef, agents, activeAgentId, setState }: UseSideChatOptions) {
  const [forkRequest, setForkRequest] = useState<SideChatForkRequest | null>(null)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [initialMessage, setInitialMessage] = useState<SideChatInitialMessage | null>(null)
  // Mirrors forkRequest for the async fork continuation; updated with every state change.
  const forkRequestRef = useRef<SideChatForkRequest | null>(null)

  // The fork result is authoritative only until WS state carries the descriptor.
  useEffect(() => {
    if (!forkRequest?.agentId) return
    if (findSideChatForSource(agents, forkRequest.sourceAgentId)?.agentId === forkRequest.agentId) {
      forkRequestRef.current = null
      setForkRequest(null)
    }
  }, [agents, forkRequest])

  const request = forkRequest?.sourceAgentId === activeAgentId ? forkRequest : null
  const sideChatAgent = findSideChatForSource(agents, activeAgentId)
  const sideChatAgentId = request ? request.agentId : sideChatAgent?.agentId ?? null
  const isCreating = Boolean(request && !request.agentId)
  const isOpen = isCreating || Boolean(sideChatAgentId)
  const isExpanded = isCreating || (sideChatAgentId !== null && sideChatAgentId === expandedAgentId)

  const reportError = useCallback((prefix: string, error: unknown) => {
    setState((prev) => ({
      ...prev,
      lastError: `${prefix}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }))
  }, [setState])

  const startSideChat = useCallback((sourceAgentId: string, text?: string) => {
    const client = clientRef.current
    if (!client) return

    const nextRequest: SideChatForkRequest = { sourceAgentId, agentId: null }
    setForkRequest(nextRequest)
    forkRequestRef.current = nextRequest

    void (async () => {
      try {
        const result = await client.forkSession(sourceAgentId, undefined, undefined, { sessionPurpose: 'side_chat' })
        const agentId = result.newSessionAgent.agentId
        if (forkRequestRef.current !== nextRequest) {
          // Discarded while the fork was in flight.
          if (!forkRequestRef.current) void client.deleteSession(agentId).catch(() => {})
          return
        }
        const createdRequest = { sourceAgentId, agentId }
        forkRequestRef.current = createdRequest
        setForkRequest(createdRequest)
        setExpandedAgentId(agentId)
        setInitialMessage(text ? { agentId, text } : null)
      } catch (error) {
        if (forkRequestRef.current === nextRequest) {
          forkRequestRef.current = null
          setForkRequest(null)
        }
        reportError('Failed to start side chat', error)
      }
    })()
  }, [clientRef, reportError])

  const discardSideChat = useCallback(() => {
    const agentId = sideChatAgentId
    forkRequestRef.current = null
    setForkRequest(null)
    setExpandedAgentId(null)
    setInitialMessage(null)
    if (!agentId) return
    clientRef.current?.deleteSession(agentId).catch((error: unknown) => {
      reportError('Failed to discard side chat', error)
    })
  }, [clientRef, reportError, sideChatAgentId])

  const clearInitialMessage = useCallback(() => setInitialMessage(null), [])

  return {
    isOpen,
    isExpanded,
    isCreating,
    sideChatAgentId,
    initialMessage: initialMessage && initialMessage.agentId === sideChatAgentId ? initialMessage : null,
    startSideChat,
    discardSideChat,
    expandSideChat: useCallback(() => setExpandedAgentId(sideChatAgentId), [sideChatAgentId]),
    collapseSideChat: useCallback(() => setExpandedAgentId(null), []),
    clearInitialMessage,
  }
}
