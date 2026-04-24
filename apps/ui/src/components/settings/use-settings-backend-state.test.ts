/** @vitest-environment jsdom */
/* eslint-disable react-hooks/globals -- test harness captures hook output via ref callback */

import { createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------ */
/*  Mock the WS client to observe connect/destroy calls               */
/* ------------------------------------------------------------------ */

const wsClientInstances: Array<{
  wsUrl: string
  started: boolean
  destroyed: boolean
  subscriber: ((state: Record<string, unknown>) => void) | null
}> = []

vi.mock('@/lib/ws-client', () => ({
  ManagerWsClient: class MockManagerWsClient {
    _record: (typeof wsClientInstances)[number]

    constructor(wsUrl: string) {
      this._record = { wsUrl, started: false, destroyed: false, subscriber: null }
      wsClientInstances.push(this._record)
    }

    getState() {
      return {
        connected: false,
        targetAgentId: null,
        subscribedAgentId: null,
        messages: [],
        activityMessages: [],
        pendingChoiceIds: new Set(),
        agents: [],
        loadedSessionIds: new Set(),
        profiles: [],
        statuses: {},
        lastError: null,
        lastSuccess: null,
        telegramStatus: null,
        playwrightSnapshot: null,
        playwrightSettings: null,
        unreadCounts: {},
        terminals: [],
        terminalSessionScopeId: null,
        hasReceivedAgentsSnapshot: false,
        promptChangeKey: 0,
        specialistChangeKey: 0,
        modelConfigChangeKey: 0,
      }
    }

    subscribe(fn: (state: Record<string, unknown>) => void) {
      this._record.subscriber = fn
      return () => { this._record.subscriber = null }
    }

    start() {
      this._record.started = true
    }

    destroy() {
      this._record.destroyed = true
    }
  },
}))

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    try {
      const parsed = new URL(wsUrl)
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      return new URL(path, parsed.origin).toString()
    } catch {
      return path
    }
  },
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://collab.example.com/',
}))

const { useSettingsBackendState } = await import('./use-settings-backend-state')
const { createBuilderSettingsTarget, createCollabSettingsTarget } = await import('./settings-target')

type BackendStateResult = ReturnType<typeof useSettingsBackendState>

/* ------------------------------------------------------------------ */
/*  Test harness — uses a ref to capture hook output without lint      */
/*  violations from mutating outer variables during render.            */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

// Storage for captured result — populated by the harness's onResult callback
let capturedResult: BackendStateResult | null = null

interface HarnessProps {
  target: ReturnType<typeof createBuilderSettingsTarget>
  enabled: boolean
  isAdmin: boolean
  isMember: boolean
  hasLoaded: boolean
}

/**
 * TestHarness wraps useSettingsBackendState and stores the result into
 * a ref that is read via a post-render callback. The outer `capturedResult`
 * is only written from the callback (outside the render phase) to satisfy
 * the react-hooks/globals lint rule.
 */
function TestHarness(props: HarnessProps) {
  const result = useSettingsBackendState(props)
  const resultRef = useRef(result)
  resultRef.current = result
  // Expose to tests via DOM attribute so we can read without lint issues
  return createElement('div', {
    'data-testid': 'harness',
    'data-ready': String(result.ready),
    'data-blocked': String(result.blockedReason),
    'data-has-ws': String(result.wsState !== null),
    ref: () => { capturedResult = resultRef.current },
  })
}

function renderHarness(props: HarnessProps) {
  root = createRoot(container)
  act(() => {
    root?.render(createElement(TestHarness, props))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  wsClientInstances.length = 0
  capturedResult = null
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container.remove()
})

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('useSettingsBackendState', () => {
  describe('builder target', () => {
    it('returns ready with no WS and no blocked reason', () => {
      const target = createBuilderSettingsTarget('ws://127.0.0.1:47187')

      renderHarness({ target, enabled: true, isAdmin: false, isMember: false, hasLoaded: true })

      expect(capturedResult?.ready).toBe(true)
      expect(capturedResult?.blockedReason).toBeNull()
      expect(capturedResult?.wsState).toBeNull()
      // No WS client should have been created
      expect(wsClientInstances).toHaveLength(0)
    })
  })

  describe('collab target — blocked', () => {
    it('blocks members with admin_required and does not create WS', () => {
      const target = createCollabSettingsTarget('wss://collab.example.com')

      renderHarness({ target, enabled: true, isAdmin: false, isMember: true, hasLoaded: true })

      expect(capturedResult?.blockedReason).toBe('admin_required')
      expect(capturedResult?.wsState).toBeNull()
      expect(wsClientInstances).toHaveLength(0)
    })

    it('blocks unauthenticated users with auth_required and does not create WS', () => {
      const target = createCollabSettingsTarget('wss://collab.example.com')

      renderHarness({ target, enabled: true, isAdmin: false, isMember: false, hasLoaded: true })

      expect(capturedResult?.blockedReason).toBe('auth_required')
      expect(capturedResult?.wsState).toBeNull()
      expect(wsClientInstances).toHaveLength(0)
    })

    it('does not create WS when disabled even for admin', () => {
      const target = createCollabSettingsTarget('wss://collab.example.com')

      renderHarness({ target, enabled: false, isAdmin: true, isMember: false, hasLoaded: true })

      expect(capturedResult?.blockedReason).toBeNull()
      expect(wsClientInstances).toHaveLength(0)
    })
  })

  describe('collab target — admin', () => {
    it('creates secondary Builder-protocol WebSocket for admin when enabled', () => {
      const target = createCollabSettingsTarget('wss://collab.example.com')

      renderHarness({ target, enabled: true, isAdmin: true, isMember: false, hasLoaded: true })

      expect(capturedResult?.blockedReason).toBeNull()
      expect(wsClientInstances).toHaveLength(1)
      expect(wsClientInstances[0]!.wsUrl).toBe('wss://collab.example.com')
      expect(wsClientInstances[0]!.started).toBe(true)
      expect(wsClientInstances[0]!.destroyed).toBe(false)
    })

    it('destroys WS on unmount', () => {
      const target = createCollabSettingsTarget('wss://collab.example.com')

      renderHarness({ target, enabled: true, isAdmin: true, isMember: false, hasLoaded: true })

      expect(wsClientInstances).toHaveLength(1)

      act(() => root?.unmount())
      root = null

      expect(wsClientInstances[0]!.destroyed).toBe(true)
    })

    it('returns wsState from secondary WS', () => {
      const target = createCollabSettingsTarget('wss://collab.example.com')

      renderHarness({ target, enabled: true, isAdmin: true, isMember: false, hasLoaded: true })

      // Initial state should be from the mock WS client
      expect(capturedResult?.wsState).toBeTruthy()
      expect(capturedResult?.wsState?.agents).toEqual([])
      expect(capturedResult?.wsState?.profiles).toEqual([])
    })
  })
})
