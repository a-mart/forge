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
    { kind: 'env' as const, variable: 'FORGE_SECRET_DEPLOY_TOKEN_A1B2C3' },
  ],
}

const secondAvailableSecret = {
  secretId: 'secret-2',
  displayAlias: 'ssh-password',
  displayName: 'SSH password',
  available: true,
  bindings: [
    { kind: 'askpass' as const, variable: 'SSH_ASKPASS' },
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
          grantSource: 'project_default',
        }],
        pendingRequests: [],
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
    }))

    openPicker(/active with 1 active lease/i)

    expect(document.body.textContent).toContain('Active leases')
    expect(document.body.textContent).toContain('deploy-token')
    expect(document.body.textContent).toContain('Project default')
    expect(document.body.textContent).toContain('Environment variable DEPLOY_TOKEN')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Revoke' }))
    })
    expect(onRevoke).toHaveBeenCalledWith('lease-1')
  })

  it('summarizes project-default readiness without provider details', () => {
    renderPicker(makeConfig({
      snapshot: {
        sessionAgentId: 'manager-1',
        revision: 4,
        executionMode: 'secure',
        environmentStatus: 'ready',
        leases: [],
        pendingRequests: [],
        projectDefaults: [
          {
            secretId: 'secret-ready',
            displayAlias: 'ready-secret',
            state: 'active',
            statusCode: 'ok',
          },
          {
            secretId: 'secret-unavailable',
            displayAlias: 'unavailable-secret',
            state: 'unavailable',
            statusCode: 'source_unavailable',
          },
          {
            secretId: 'secret-conflict',
            displayAlias: 'conflicting-secret',
            state: 'conflict',
            statusCode: 'binding_conflict',
          },
        ],
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
    }))

    openPicker(/secure session ready/i)

    expect(getByRole(document.body, 'generic', {
      name: 'Project default status',
    }).textContent).toBe(
      '3 project defaults · 1 ready · 1 unavailable · 1 conflict',
    )
    expect(document.body.textContent).not.toContain('provider')
  })

  it('defaults to session-lifetime access and grants several saved secrets together', async () => {
    const onGrant = vi.fn()
    renderPicker(makeConfig({
      onGrant,
      secrets: [availableSecret, secondAvailableSecret],
    }))

    openPicker(/secure session ready/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant secrets' }))
    })

    expect(getByLabelText(document.body, /Deploy token/)).toBeTruthy()
    expect(getByLabelText(document.body, /SSH password/)).toBeTruthy()
    expect(getByLabelText(document.body, 'Scope')).toBeTruthy()
    expect(document.body.querySelector('input[type="password"]')).toBeNull()
    expect((getByLabelText(document.body, 'Scope') as HTMLSelectElement).value).toBe('task')
    expect(getByRole(document.body, 'option', {
      name: 'Until Secure Session stops',
    })).toBeTruthy()
    expect(document.body.textContent).toContain('whole command process')

    flushSync(() => {
      fireEvent.click(getByLabelText(document.body, /SSH password/))
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant 2 secrets' }))
    })

    expect(onGrant).toHaveBeenCalledWith([
      {
        secretId: 'secret-1',
        bindings: [{
          kind: 'env',
          variable: 'FORGE_SECRET_DEPLOY_TOKEN_A1B2C3',
        }],
        policy: { kind: 'task' },
      },
      {
        secretId: 'secret-2',
        bindings: [{ kind: 'askpass', variable: 'SSH_ASKPASS' }],
        policy: { kind: 'task' },
      },
    ])
  })

  it('removes selections that become ungrantable while review remains open', async () => {
    const onGrant = vi.fn(async () => false)
    const config = makeConfig({
      onGrant,
      secrets: [availableSecret, secondAvailableSecret],
    })
    renderPicker(config)

    openPicker(/secure session ready/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant secrets' }))
    })
    flushSync(() => {
      fireEvent.click(getByLabelText(document.body, /SSH password/))
    })
    expect(getByRole(document.body, 'button', { name: 'Grant 2 secrets' })).toBeTruthy()

    renderPicker({
      ...config,
      snapshot: {
        ...config.snapshot!,
        revision: 4,
        leases: [{
          leaseId: 'lease-2',
          secretId: 'secret-2',
          displayAlias: 'ssh-password',
          policy: { kind: 'task' },
          status: 'active',
          bindings: [{ kind: 'askpass', variable: 'SSH_ASKPASS' }],
        }],
      },
    })

    await vi.waitFor(() => {
      expect(getByRole(document.body, 'button', { name: 'Grant 1 secret' })).toBeTruthy()
      expect(document.body.textContent).not.toContain('SSH password')
    })

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Grant 1 secret' }))
    })
    await vi.waitFor(() => {
      expect(onGrant).toHaveBeenCalledWith([{
        secretId: 'secret-1',
        bindings: [{
          kind: 'env',
          variable: 'FORGE_SECRET_DEPLOY_TOKEN_A1B2C3',
        }],
        policy: { kind: 'task' },
      }])
    })
  })

  it('opens the grant dialog immediately after starting successfully', async () => {
    const onStart = vi.fn(async () => true)
    renderPicker(makeConfig({
      onStart,
      snapshot: {
        sessionAgentId: 'manager-1',
        revision: 1,
        executionMode: 'standard',
        environmentStatus: 'stopped',
        leases: [],
        pendingRequests: [],
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
    }))

    openPicker(/start a secure session/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Start secure session' }))
    })
    await onStart.mock.results[0]?.value
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getByRole(document.body, 'heading', { name: 'Grant secrets' })).toBeTruthy()
  })

  it('requires explicit confirmation before stopping processes and revoking all leases', () => {
    const onRevoke = vi.fn()
    renderPicker(makeConfig({
      onRevoke,
      outputState: 'quarantined',
      outputStateReason: 'Potential secret material was withheld.',
    }))

    openPicker(/protected output redacted/i)
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
