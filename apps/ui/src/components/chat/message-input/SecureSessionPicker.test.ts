/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureSessionPickerConfig } from '../secure-session/types'
import { SecureSessionPicker } from './SecureSessionPicker'

let container: HTMLDivElement
let root: Root
const originalResizeObserver = globalThis.ResizeObserver

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

const availableSecret = {
  secretId: 'secret-1',
  displayAlias: 'deploy-token',
  displayName: 'Deploy token',
  available: true,
  bindings: [
    { kind: 'env' as const, variable: 'DEPLOY_TOKEN' },
    { kind: 'stdin' as const },
  ],
}

function makeConfig(
  overrides: Partial<SecureSessionPickerConfig> = {},
): SecureSessionPickerConfig {
  return {
    availability: { state: 'available' },
    snapshot: {
      sessionAgentId: 'manager-1',
      revision: 3,
      executionMode: 'secure',
      environmentStatus: 'ready',
      leases: [],
      pendingRequests: [],
      updatedAt: '2026-07-23T12:00:00.000Z',
    },
    secrets: [availableSecret],
    onGrant: vi.fn(),
    onRevoke: vi.fn(),
    ...overrides,
  }
}

function renderPicker(config: SecureSessionPickerConfig) {
  flushSync(() => {
    root.render(createElement(SecureSessionPicker, { config }))
  })
}

function openPicker(name: RegExp) {
  flushSync(() => {
    fireEvent.click(getByRole(container, 'button', { name }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  globalThis.ResizeObserver = originalResizeObserver
  vi.restoreAllMocks()
})

describe('SecureSessionPicker', () => {
  it('shows active leases in a compact popover and supports narrow revocation', () => {
    const onRevoke = vi.fn()
    renderPicker(makeConfig({
      onRevoke,
      snapshot: {
        sessionAgentId: 'manager-1',
        revision: 4,
        executionMode: 'secure',
        environmentStatus: 'ready',
        leases: [{
          leaseId: 'lease-1',
          secretId: 'secret-1',
          displayAlias: 'deploy-token',
          policy: { kind: 'task' },
          status: 'active',
          bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
        }],
        pendingRequests: [],
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
    }))

    openPicker(/active with 1 active lease/i)

    expect(document.body.textContent).toContain('Active leases')
    expect(document.body.textContent).toContain('deploy-token')
    expect(document.body.textContent).toContain('Environment variable DEPLOY_TOKEN')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Revoke' }))
    })
    expect(onRevoke).toHaveBeenCalledWith('lease-1')
  })

  it('collects only alias, binding, and scope metadata for proactive grants', () => {
    const onGrant = vi.fn()
    renderPicker(makeConfig({ onGrant }))

    openPicker(/secure session ready/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant a secret' }))
    })

    expect(getByLabelText(document.body, 'Secret alias')).toBeTruthy()
    expect(getByLabelText(document.body, 'Binding')).toBeTruthy()
    expect(getByLabelText(document.body, 'Scope')).toBeTruthy()
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    expect(document.body.textContent).toContain('next Secure Bash command')
    expect(document.body.textContent).toContain('whole command process')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant access' }))
    })

    expect(onGrant).toHaveBeenCalledWith({
      secretId: 'secret-1',
      bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
      policy: { kind: 'one_use' },
    })
  })

  it('requires explicit confirmation before stopping processes and revoking all leases', () => {
    const onRevoke = vi.fn()
    renderPicker(makeConfig({
      onRevoke,
      outputState: 'quarantined',
      outputStateReason: 'Potential secret material was withheld.',
    }))

    openPicker(/output quarantined/i)
    expect(document.body.textContent).toContain('Potential secret material was withheld.')
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Stop processes and revoke' }))
    })

    expect(onRevoke).not.toHaveBeenCalled()
    expect(getByRole(document.body, 'heading', {
      name: 'Stop processes and revoke access?',
    })).toBeTruthy()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Stop processes and revoke' }))
    })
    expect(onRevoke).toHaveBeenCalledWith(undefined, { stopProcesses: true })
  })

  it.each([
    ['unsupported runtime', 'unsupported_runtime' as const, 'does not support Secure Sessions'],
    ['remote origin', 'remote_origin' as const, 'unavailable for remote projects'],
    ['source unavailable', 'source_unavailable' as const, 'secure secret source is unavailable'],
  ])('renders the %s state without exposing grant actions', (_label, state, text) => {
    renderPicker(makeConfig({
      availability: { state },
      snapshot: null,
    }))

    openPicker(new RegExp(`secure session:.*${text}`, 'i'))

    expect(document.body.textContent).toContain(text)
    expect(document.body.textContent).not.toContain('Grant a secret')
  })
})
