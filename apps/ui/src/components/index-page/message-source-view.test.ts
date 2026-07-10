/** @vitest-environment jsdom */

import { createElement, useEffect, useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageSourceView } from '@/components/chat/ChatHeader'
import { defaultMessageSourceViewForAgentRole } from './message-source-view'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('defaultMessageSourceViewForAgentRole', () => {
  it('defaults selected workers to All', () => {
    expect(defaultMessageSourceViewForAgentRole('worker')).toBe('all')
  })

  it('preserves the Web default for managers and unset selection', () => {
    expect(defaultMessageSourceViewForAgentRole('manager')).toBe('web')
    expect(defaultMessageSourceViewForAgentRole(null)).toBe('web')
    expect(defaultMessageSourceViewForAgentRole(undefined)).toBe('web')
  })
})

type HarnessAgent = {
  agentId: string
  role: 'manager' | 'worker'
}

type HarnessState = {
  messageSourceView: MessageSourceView
  setActiveAgent: (agent: HarnessAgent | null) => void
  setMessageSourceView: (view: MessageSourceView) => void
}

const capturedRef: { current: HarnessState | null } = { current: null }

/**
 * Mirrors BuilderSurface's agent-switch chrome reset for messageSourceView:
 * when the active agent changes, re-apply the role-based default.
 */
function MessageSourceViewHarness() {
  const [activeAgent, setActiveAgent] = useState<HarnessAgent | null>(null)
  const [messageSourceView, setMessageSourceView] = useState<MessageSourceView>('web')

  useEffect(() => {
    setMessageSourceView(defaultMessageSourceViewForAgentRole(activeAgent?.role))
  }, [activeAgent?.agentId, activeAgent?.role])

  capturedRef.current = {
    messageSourceView,
    setActiveAgent,
    setMessageSourceView,
  }

  return null
}

describe('messageSourceView agent transitions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement(MessageSourceViewHarness))
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    capturedRef.current = null
  })

  it('switches to All when selecting a worker, then back to Web for a manager', () => {
    const harness = capturedRef.current
    expect(harness).not.toBeNull()
    expect(harness!.messageSourceView).toBe('web')

    act(() => {
      harness!.setActiveAgent({ agentId: 'worker-1', role: 'worker' })
    })
    expect(capturedRef.current!.messageSourceView).toBe('all')

    act(() => {
      harness!.setActiveAgent({ agentId: 'manager-1', role: 'manager' })
    })
    expect(capturedRef.current!.messageSourceView).toBe('web')
  })

  it('re-applies All when moving between workers even after a manual Web override', () => {
    const harness = capturedRef.current
    expect(harness).not.toBeNull()

    act(() => {
      harness!.setActiveAgent({ agentId: 'worker-1', role: 'worker' })
    })
    expect(capturedRef.current!.messageSourceView).toBe('all')

    act(() => {
      capturedRef.current!.setMessageSourceView('web')
    })
    expect(capturedRef.current!.messageSourceView).toBe('web')

    act(() => {
      capturedRef.current!.setActiveAgent({ agentId: 'worker-2', role: 'worker' })
    })
    expect(capturedRef.current!.messageSourceView).toBe('all')
  })

  it('keeps Web when switching between managers after a manual All override', () => {
    const harness = capturedRef.current
    expect(harness).not.toBeNull()

    act(() => {
      harness!.setActiveAgent({ agentId: 'manager-1', role: 'manager' })
    })
    expect(capturedRef.current!.messageSourceView).toBe('web')

    act(() => {
      capturedRef.current!.setMessageSourceView('all')
    })
    expect(capturedRef.current!.messageSourceView).toBe('all')

    act(() => {
      capturedRef.current!.setActiveAgent({ agentId: 'manager-2', role: 'manager' })
    })
    expect(capturedRef.current!.messageSourceView).toBe('web')
  })
})
