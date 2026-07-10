/** @vitest-environment jsdom */

import { createElement, createRef, forwardRef, useEffect, useImperativeHandle, useState } from 'react'
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

/**
 * Mirrors BuilderSurface's agent-switch chrome reset for messageSourceView:
 * when the active agent changes, re-apply the role-based default.
 */
const MessageSourceViewHarness = forwardRef<HarnessState>(function MessageSourceViewHarness(_props, ref) {
  const [activeAgent, setActiveAgent] = useState<HarnessAgent | null>(null)
  const [messageSourceView, setMessageSourceView] = useState<MessageSourceView>('web')

  useEffect(() => {
    setMessageSourceView(defaultMessageSourceViewForAgentRole(activeAgent?.role))
  }, [activeAgent?.agentId, activeAgent?.role])

  useImperativeHandle(ref, () => ({
    messageSourceView,
    setActiveAgent,
    setMessageSourceView,
  }), [messageSourceView])

  return null
})

describe('messageSourceView agent transitions', () => {
  let container: HTMLDivElement
  let root: Root
  let harnessRef: ReturnType<typeof createRef<HarnessState>>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    harnessRef = createRef<HarnessState>()
    act(() => {
      root.render(createElement(MessageSourceViewHarness, { ref: harnessRef }))
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('switches to All when selecting a worker, then back to Web for a manager', () => {
    const harness = harnessRef.current
    expect(harness).not.toBeNull()
    expect(harness!.messageSourceView).toBe('web')

    act(() => {
      harness!.setActiveAgent({ agentId: 'worker-1', role: 'worker' })
    })
    expect(harnessRef.current!.messageSourceView).toBe('all')

    act(() => {
      harness!.setActiveAgent({ agentId: 'manager-1', role: 'manager' })
    })
    expect(harnessRef.current!.messageSourceView).toBe('web')
  })

  it('re-applies All when moving between workers even after a manual Web override', () => {
    const harness = harnessRef.current
    expect(harness).not.toBeNull()

    act(() => {
      harness!.setActiveAgent({ agentId: 'worker-1', role: 'worker' })
    })
    expect(harnessRef.current!.messageSourceView).toBe('all')

    act(() => {
      harnessRef.current!.setMessageSourceView('web')
    })
    expect(harnessRef.current!.messageSourceView).toBe('web')

    act(() => {
      harnessRef.current!.setActiveAgent({ agentId: 'worker-2', role: 'worker' })
    })
    expect(harnessRef.current!.messageSourceView).toBe('all')
  })

  it('keeps Web when switching between managers after a manual All override', () => {
    const harness = harnessRef.current
    expect(harness).not.toBeNull()

    act(() => {
      harness!.setActiveAgent({ agentId: 'manager-1', role: 'manager' })
    })
    expect(harnessRef.current!.messageSourceView).toBe('web')

    act(() => {
      harnessRef.current!.setMessageSourceView('all')
    })
    expect(harnessRef.current!.messageSourceView).toBe('all')

    act(() => {
      harnessRef.current!.setActiveAgent({ agentId: 'manager-2', role: 'manager' })
    })
    expect(harnessRef.current!.messageSourceView).toBe('web')
  })
})
