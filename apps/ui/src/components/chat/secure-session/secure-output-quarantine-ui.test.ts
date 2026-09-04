/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement, useEffect, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../MessageList'
import { SecureSessionPicker } from '../message-input/SecureSessionPicker'
import {
  installVirtualizationHarness,
  type VirtualizationHarness,
} from '../message-list/test-virtualization-harness'
import {
  resolveSecureOutputQuarantineUi,
  secureOutputQuarantineConfigFields,
} from './output-quarantine'
import type {
  SecureSessionPickerConfig,
  SecureSessionRequestConfig,
  SecureSessionSnapshotView,
} from './types'

let root: Root
let container: HTMLDivElement
let virt: VirtualizationHarness
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 0)) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) =>
    window.clearTimeout(id)) as typeof cancelAnimationFrame
  virt = installVirtualizationHarness()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  virt.restore()
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  vi.restoreAllMocks()
})

function snapshot(
  overrides: Partial<SecureSessionSnapshotView> = {},
): SecureSessionSnapshotView {
  return {
    sessionAgentId: 'manager-1',
    principalKind: 'manager',
    revision: 6,
    executionMode: 'secure',
    environmentStatus: 'ready',
    outputState: 'quarantined',
    leases: [],
    pendingRequests: [],
    updatedAt: '2026-07-23T12:00:00.000Z',
    ...overrides,
  }
}

function Harness({
  currentSnapshot,
  originId = 'origin-a',
}: {
  currentSnapshot: SecureSessionSnapshotView
  originId?: string
}) {
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null)
  useEffect(() => {
    if (currentSnapshot.outputState !== 'quarantined' && acknowledgedKey !== null) {
      setAcknowledgedKey(null)
    }
  }, [acknowledgedKey, currentSnapshot.outputState])
  const ui = useMemo(
    () => resolveSecureOutputQuarantineUi({
      snapshot: currentSnapshot,
      originId,
      acknowledgedKey,
    }),
    [acknowledgedKey, currentSnapshot, originId],
  )
  const picker: SecureSessionPickerConfig = {
    originId,
    availability: { state: 'available' },
    snapshot: currentSnapshot,
    secrets: [],
    ...secureOutputQuarantineConfigFields(ui),
  }
  const requests: SecureSessionRequestConfig = {
    originId,
    sessionAgentId: currentSnapshot.sessionAgentId,
    availability: { state: 'available' },
    requests: [],
    secrets: [],
    ...secureOutputQuarantineConfigFields(ui),
    onGrant: vi.fn(),
    onDeny: vi.fn(),
    onDismissOutputQuarantine: () => {
      if (ui.eventKey) setAcknowledgedKey(ui.eventKey)
    },
  }

  return createElement(
    'div',
    null,
    createElement(MessageList, {
      messages: [],
      isLoading: false,
      activeAgentId: 'session-1',
      pendingChoiceIds: new Set<string>(),
      agents: [],
      statuses: {},
      secureSessionRequests: requests,
    }),
    createElement(SecureSessionPicker, { config: picker }),
  )
}

describe('secure output quarantine UI', () => {
  it('dismisses the notice and picker warning together, then re-shows on a new event', () => {
    const first = snapshot()
    flushSync(() => {
      root.render(createElement(Harness, { currentSnapshot: first }))
    })

    expect(container.textContent).toContain('Protected output redacted')
    expect(getByRole(container, 'button', {
      name: /protected output redacted/i,
    })).toBeTruthy()

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Dismiss' }))
    })
    expect(container.querySelector('[data-testid="secure-session-attention"]')).toBeNull()
    expect(getByRole(container, 'button', {
      name: /secure session ready/i,
    })).toBeTruthy()

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: /secure session ready/i }))
    })
    const popover = Array.from(
      document.body.querySelectorAll('[data-slot="popover-content"]'),
    ).find((candidate) => candidate.textContent?.includes('Team Secure Mode'))
    expect(popover?.textContent).not.toContain('Protected output redacted')

    flushSync(() => {
      root.render(createElement(Harness, {
        currentSnapshot: snapshot({
          revision: 7,
          updatedAt: '2026-07-23T12:05:00.000Z',
        }),
      }))
    })
    expect(container.textContent).toContain('Protected output redacted')
    expect(getByRole(container, 'button', {
      name: /protected output redacted/i,
    })).toBeTruthy()
  })

  it('uses the same acknowledged key for manager and worker views of one snapshot', () => {
    const current = snapshot()
    const originId = 'origin-a'
    const acknowledged = resolveSecureOutputQuarantineUi({
      snapshot: current,
      originId,
      acknowledgedKey: null,
    }).eventKey

    const manager = resolveSecureOutputQuarantineUi({
      snapshot: current,
      originId,
      acknowledgedKey: acknowledged,
    })
    const worker = resolveSecureOutputQuarantineUi({
      snapshot: {
        ...current,
        principalKind: 'worker',
        ownerManagerAgentId: current.sessionAgentId,
      },
      originId,
      acknowledgedKey: acknowledged,
    })

    expect(manager.outputState).toBe('clear')
    expect(worker.outputState).toBe('clear')
    expect(manager.eventKey).toBe(worker.eventKey)
  })
})
