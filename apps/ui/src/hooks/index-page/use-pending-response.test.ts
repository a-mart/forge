/** @vitest-environment jsdom */

import { createElement, useState, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePendingResponse } from './use-pending-response'
import type { ConversationEntry } from '@forge/protocol'

type PendingResponseReturn = ReturnType<typeof usePendingResponse>

let container: HTMLDivElement
let root: Root | null = null
const capturedRef: {
  current: {
    result: PendingResponseReturn
    setAgentId: (id: string | null) => void
    setStatus: (status: string | null) => void
    setMessages: (msgs: ConversationEntry[]) => void
  } | null
} = { current: null }

function PendingResponseHarness() {
  const [activeAgentId, setActiveAgentId] = useState<string | null>('agent-1')
  const [activeAgentStatus, setActiveAgentStatus] = useState<string | null>('idle')
  const [messages, setMessagesState] = useState<ConversationEntry[]>([])

  const result = usePendingResponse({ activeAgentId, activeAgentStatus, messages })

  const setAgentId = useCallback((id: string | null) => setActiveAgentId(id), [])
  const setStatus = useCallback((s: string | null) => setActiveAgentStatus(s), [])
  const setMessages = useCallback((m: ConversationEntry[]) => setMessagesState(m), [])

  useEffect(() => {
    capturedRef.current = { result, setAgentId, setStatus, setMessages }
  })

  return null
}

function makeAssistantMessage(): ConversationEntry {
  return {
    type: 'conversation_message',
    agentId: 'agent-1',
    role: 'assistant',
    text: 'Hello!',
    timestamp: new Date().toISOString(),
    source: 'speak_to_user',
  }
}

function makeSystemMessage(): ConversationEntry {
  return {
    type: 'conversation_message',
    agentId: 'agent-1',
    role: 'system',
    text: 'System message',
    timestamp: new Date().toISOString(),
    source: 'system',
  }
}

function makeUserMessage(): ConversationEntry {
  return {
    type: 'conversation_message',
    agentId: 'agent-1',
    role: 'user',
    text: 'User input',
    timestamp: new Date().toISOString(),
    source: 'user_input',
  }
}

function makeMessageStart(): ConversationEntry {
  return {
    type: 'conversation_log',
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    source: 'runtime_log',
    kind: 'message_start',
    role: 'assistant',
    text: '',
  }
}

function makeMessageEnd(): ConversationEntry {
  return {
    type: 'conversation_log',
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    source: 'runtime_log',
    kind: 'message_end',
    role: 'assistant',
    text: '',
  }
}

function makeToolEvent(): ConversationEntry {
  return {
    type: 'conversation_log',
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    source: 'runtime_log',
    kind: 'tool_execution_start',
    role: 'assistant',
    toolName: 'read',
    toolCallId: 'tc-1',
    text: '{}',
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  capturedRef.current = null
  container.remove()
})

function render() {
  act(() => {
    root = createRoot(container)
    root.render(createElement(PendingResponseHarness))
  })
}

describe('usePendingResponse', () => {
  describe('initial state', () => {
    it('starts with no pending response', () => {
      render()
      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(false)
    })
  })

  describe('markPendingResponse', () => {
    it('marks a pending response for the active agent', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      expect(capturedRef.current!.result.pendingResponseStart).toEqual({
        agentId: 'agent-1',
        messageCount: 0,
      })
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(true)
    })

    it('immediately clears when pending agent differs from active agent', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('other-agent', 0)
      })

      // The useEffect detects mismatch and clears the pending state
      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(false)
    })
  })

  describe('clears on streaming', () => {
    it('clears pending response when status becomes streaming', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })
      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()

      act(() => {
        capturedRef.current!.setStatus('streaming')
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(false)
    })
  })

  describe('clears on assistant/system conversation_message', () => {
    it('clears when an assistant conversation_message appears after the marked position', () => {
      render()

      const userMsg = makeUserMessage()

      act(() => {
        capturedRef.current!.setMessages([userMsg])
      })
      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 1) // marked at position 1
      })
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(true)

      // Add an assistant message after the marked position
      act(() => {
        capturedRef.current!.setMessages([userMsg, makeAssistantMessage()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })

    it('clears when a system conversation_message appears after the marked position', () => {
      render()

      const userMsg = makeUserMessage()

      act(() => {
        capturedRef.current!.setMessages([userMsg])
      })
      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 1)
      })
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(true)

      act(() => {
        capturedRef.current!.setMessages([userMsg, makeSystemMessage()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })

    it('does NOT clear on a user conversation_message', () => {
      render()

      const userMsg = makeUserMessage()

      act(() => {
        capturedRef.current!.setMessages([userMsg])
      })
      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 1)
      })

      act(() => {
        capturedRef.current!.setMessages([userMsg, makeUserMessage()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()
    })
  })

  describe('clears on assistant message_start/message_end', () => {
    it('clears on assistant message_start conversation_log', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      act(() => {
        capturedRef.current!.setMessages([makeMessageStart()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })

    it('clears on assistant message_end conversation_log', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      act(() => {
        capturedRef.current!.setMessages([makeMessageEnd()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })

    it('does NOT clear on tool_execution_start log', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      act(() => {
        capturedRef.current!.setMessages([makeToolEvent()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()
    })
  })

  describe('clears on active-agent change', () => {
    it('clears pending response when active agent changes', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })
      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()

      act(() => {
        capturedRef.current!.setAgentId('agent-2')
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })

    it('clears pending response when active agent becomes null', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      act(() => {
        capturedRef.current!.setAgentId(null)
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })
  })

  describe('clears on truncated message list', () => {
    it('clears when message count drops below the marked count', () => {
      render()

      const msgs = [makeUserMessage(), makeUserMessage(), makeUserMessage()]
      act(() => {
        capturedRef.current!.setMessages(msgs)
      })
      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 3)
      })
      expect(capturedRef.current!.result.isAwaitingResponseStart).toBe(true)

      // Truncate to fewer messages than marked
      act(() => {
        capturedRef.current!.setMessages([makeUserMessage()])
      })

      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })
  })

  describe('clearPendingResponseForAgent', () => {
    it('clears pending response only for the matching agent', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      // Try clearing for wrong agent — should NOT clear
      act(() => {
        capturedRef.current!.result.clearPendingResponseForAgent('agent-2')
      })
      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()

      // Clear for correct agent
      act(() => {
        capturedRef.current!.result.clearPendingResponseForAgent('agent-1')
      })
      expect(capturedRef.current!.result.pendingResponseStart).toBeNull()
    })
  })

  describe('does not clear on non-signal messages', () => {
    it('does not clear on agent_message events', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      act(() => {
        capturedRef.current!.setMessages([
          {
            type: 'agent_message',
            agentId: 'agent-1',
            timestamp: new Date().toISOString(),
            source: 'agent_to_agent',
            toAgentId: 'worker-1',
            text: 'do something',
          },
        ])
      })

      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()
    })

    it('does not clear on agent_tool_call events', () => {
      render()

      act(() => {
        capturedRef.current!.result.markPendingResponse('agent-1', 0)
      })

      act(() => {
        capturedRef.current!.setMessages([
          {
            type: 'agent_tool_call',
            agentId: 'agent-1',
            actorAgentId: 'agent-1',
            timestamp: new Date().toISOString(),
            kind: 'tool_execution_start',
            toolName: 'read',
            toolCallId: 'tc-1',
            text: '{}',
          },
        ])
      })

      expect(capturedRef.current!.result.pendingResponseStart).not.toBeNull()
    })
  })
})
