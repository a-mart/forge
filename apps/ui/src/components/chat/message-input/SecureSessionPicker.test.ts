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
      principalKind: 'manager',
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
        principalKind: 'manager',
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
    expect(document.body.textContent).not.toContain('Grant secrets')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Revoke' }))
    })
    expect(onRevoke).toHaveBeenCalledWith('manager-1', 'lease-1')
  })

  it('shows compact team project-default states and one manager apply action', async () => {
    const onApplyProjectDefaults = vi.fn(async () => {})
    const onReviewProjectSecrets = vi.fn()
    renderPicker(makeConfig({
      onApplyProjectDefaults,
      onReviewProjectSecrets,
      snapshot: {
        sessionAgentId: 'manager-1',
        principalKind: 'manager',
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
      teamMembers: [{
        sessionAgentId: 'worker-1',
        displayName: 'Deploy worker',
        snapshot: {
          sessionAgentId: 'worker-1',
          principalKind: 'worker',
          ownerManagerAgentId: 'manager-1',
          revision: 5,
          executionMode: 'secure',
          environmentStatus: 'ready',
          leases: [],
          pendingRequests: [],
          projectDefaults: [{
            secretId: 'secret-ready',
            displayAlias: 'ready-secret',
            state: 'configured',
            statusCode: 'ok',
          }],
          updatedAt: '2026-07-23T12:00:00.000Z',
        },
      }],
    }))

    openPicker(/secure session ready/i)

    const defaults = getByRole(document.body, 'region', {
      name: 'Project default status',
    })
    expect(defaults.textContent).toContain('ready-secretReady to apply')
    expect(defaults.textContent).toContain('unavailable-secretUnavailable')
    expect(defaults.textContent).toContain('conflicting-secretBinding conflict')
    expect(getByRole(defaults, 'button', { name: 'Apply now' })).toBeTruthy()
    expect(defaults.querySelectorAll('button').length).toBe(2)
    expect(document.body.textContent).not.toContain('provider')

    flushSync(() => {
      fireEvent.click(getByRole(defaults, 'button', { name: 'Apply now' }))
    })
    await vi.waitFor(() => {
      expect(onApplyProjectDefaults).toHaveBeenCalledTimes(1)
      expect(onApplyProjectDefaults).toHaveBeenCalledWith('manager-1')
      expect((getByRole(defaults, 'button', {
        name: 'Review project secrets',
      }) as HTMLButtonElement).disabled).toBe(false)
    })

    flushSync(() => {
      fireEvent.click(getByRole(defaults, 'button', {
        name: 'Review project secrets',
      }))
    })
    expect(onReviewProjectSecrets).toHaveBeenCalledTimes(1)
  })

  it('shows an active project default without apply or review actions', () => {
    renderPicker(makeConfig({
      onApplyProjectDefaults: vi.fn(),
      onReviewProjectSecrets: vi.fn(),
      snapshot: {
        ...makeConfig().snapshot!,
        projectDefaults: [{
          secretId: 'secret-active',
          displayAlias: 'active-secret',
          state: 'active',
          statusCode: 'ok',
        }],
      },
    }))

    openPicker(/secure session ready/i)

    const defaults = getByRole(document.body, 'region', {
      name: 'Project default status',
    })
    expect(defaults.textContent).toContain('active-secretActive')
    expect(defaults.querySelector('button')).toBeNull()
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

    expect(onGrant).toHaveBeenCalledWith('manager-1', [
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
      expect(onGrant).toHaveBeenCalledWith('manager-1', [{
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
        principalKind: 'manager',
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

  it('does not open a grant dialog when project defaults were granted during startup', async () => {
    const startedSnapshot = {
      sessionAgentId: 'manager-1',
      principalKind: 'manager' as const,
      revision: 2,
      executionMode: 'secure' as const,
      environmentStatus: 'ready' as const,
      leases: [{
        leaseId: 'lease-default',
        secretId: 'secret-1',
        displayAlias: 'deploy-token',
        policy: { kind: 'task' as const },
        status: 'active' as const,
        bindings: [{ kind: 'env' as const, variable: 'DEPLOY_TOKEN' }],
        grantSource: 'project_default' as const,
      }],
      pendingRequests: [],
      projectDefaults: [{
        secretId: 'secret-1',
        displayAlias: 'deploy-token',
        state: 'active' as const,
        statusCode: 'ok' as const,
      }],
      updatedAt: '2026-07-23T12:00:01.000Z',
    }
    const onStart = vi.fn(async () => startedSnapshot)
    renderPicker(makeConfig({
      onStart,
      snapshot: {
        ...startedSnapshot,
        revision: 1,
        executionMode: 'standard',
        environmentStatus: 'stopped',
        leases: [],
        projectDefaults: [{
          ...startedSnapshot.projectDefaults[0],
          state: 'configured',
        }],
      },
    }))

    openPicker(/start a secure session/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Start secure session' }))
    })
    await onStart.mock.results[0]?.value
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull()
  })

  it('reopens secure status when a project default still needs recovery after startup', async () => {
    const unavailableDefault = {
      secretId: 'secret-1',
      displayAlias: 'deploy-token',
      state: 'unavailable' as const,
      statusCode: 'source_unavailable' as const,
    }
    const startedSnapshot = {
      sessionAgentId: 'manager-1',
      principalKind: 'manager' as const,
      revision: 2,
      executionMode: 'secure' as const,
      environmentStatus: 'ready' as const,
      leases: [],
      pendingRequests: [],
      projectDefaults: [unavailableDefault],
      updatedAt: '2026-07-23T12:00:01.000Z',
    }
    const onStart = vi.fn(async () => startedSnapshot)
    const onReviewProjectSecrets = vi.fn()
    renderPicker(makeConfig({
      onStart,
      onReviewProjectSecrets,
      snapshot: {
        ...startedSnapshot,
        revision: 1,
        executionMode: 'standard',
        environmentStatus: 'stopped',
      },
    }))

    openPicker(/start a secure session/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Start secure session' }))
    })
    await onStart.mock.results[0]?.value
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull()
    const defaults = getByRole(document.body, 'region', {
      name: 'Project default status',
    })
    expect(defaults.textContent).toContain('deploy-tokenUnavailable')
    expect(getByRole(defaults, 'button', {
      name: 'Review project secrets',
    })).toBeTruthy()
  })

  it('does not reopen a grant dialog when a start finishes after the selected session changes', async () => {
    let resolveStart: ((value: boolean) => void) | undefined
    const onStart = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveStart = resolve
    }))
    renderPicker(makeConfig({
      originId: 'project-a',
      onStart,
      snapshot: {
        sessionAgentId: 'manager-a',
        principalKind: 'manager',
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

    renderPicker(makeConfig({
      originId: 'project-b',
      snapshot: {
        sessionAgentId: 'manager-b',
        principalKind: 'manager',
        revision: 2,
        executionMode: 'secure',
        environmentStatus: 'ready',
        leases: [],
        pendingRequests: [],
        updatedAt: '2026-07-23T12:00:01.000Z',
      },
    }))
    resolveStart?.(true)
    await onStart.mock.results[0]?.value
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps secure status open when startup fails so recovery is not hidden', async () => {
    const onStart = vi.fn(async () => false)
    renderPicker(makeConfig({
      onStart,
      snapshot: {
        sessionAgentId: 'manager-1',
        principalKind: 'manager',
        revision: 1,
        executionMode: 'standard',
        environmentStatus: 'stopped',
        leases: [],
        pendingRequests: [],
        projectDefaults: [{
          secretId: 'secret-1',
          displayAlias: 'deploy-token',
          state: 'unavailable',
          statusCode: 'source_unavailable',
        }],
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
      onReviewProjectSecrets: vi.fn(),
    }))

    openPicker(/start a secure session/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Start secure session' }))
    })
    await onStart.mock.results[0]?.value
    await new Promise((resolve) => setTimeout(resolve, 0))

    const defaults = getByRole(document.body, 'region', {
      name: 'Project default status',
    })
    expect(defaults.textContent).toContain('deploy-tokenUnavailable')
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull()
  })

  it('routes an empty vault directly to project secrets without opening a grant dialog', () => {
    const onReviewProjectSecrets = vi.fn()
    renderPicker(makeConfig({
      secrets: [],
      onReviewProjectSecrets,
    }))

    openPicker(/secure session ready/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Add project secret' }))
    })

    expect(onReviewProjectSecrets).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('routes unavailable saved secrets to project settings without an empty grant dialog', () => {
    const onReviewProjectSecrets = vi.fn()
    renderPicker(makeConfig({
      secrets: [{
        ...availableSecret,
        available: false,
      }],
      onReviewProjectSecrets,
    }))

    openPicker(/secure session ready/i)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', {
        name: 'Review unavailable secrets',
      }))
    })

    expect(onReviewProjectSecrets).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
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
    expect(onRevoke).toHaveBeenCalledWith(
      'manager-1',
      undefined,
      { stopProcesses: true },
    )
  })

  it('shows owned worker status and revokes against the exact worker principal', () => {
    const onRevoke = vi.fn()
    renderPicker(makeConfig({
      onRevoke,
      teamMembers: [{
        sessionAgentId: 'worker-1',
        displayName: 'Deploy worker',
        snapshot: {
          sessionAgentId: 'worker-1',
          principalKind: 'worker',
          ownerManagerAgentId: 'manager-1',
          revision: 5,
          executionMode: 'secure',
          environmentStatus: 'ready',
          leases: [{
            leaseId: 'worker-lease-1',
            secretId: 'secret-1',
            displayAlias: 'deploy-token',
            policy: { kind: 'task' },
            status: 'active',
            bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
          }],
          pendingRequests: [],
          updatedAt: '2026-07-23T12:00:00.000Z',
        },
      }],
    }))

    openPicker(/Secure session ready/)
    const member = document.body.querySelector<HTMLElement>(
      '[data-secure-team-member="worker-1"]',
    )
    expect(member?.textContent).toContain('Deploy worker')
    expect(member?.textContent).toContain('Secure · 1 grant')
    flushSync(() => {
      fireEvent.click(getByRole(member!, 'button', { name: 'Revoke' }))
    })
    expect(onRevoke).toHaveBeenCalledWith('worker-1', 'worker-lease-1')
  })

  it('keeps a worker view read-only while showing its own isolated grants', () => {
    const onGrant = vi.fn()
    const onRevoke = vi.fn()
    const onApplyProjectDefaults = vi.fn()
    const onReviewProjectSecrets = vi.fn()
    renderPicker(makeConfig({
      readOnly: true,
      snapshot: {
        sessionAgentId: 'worker-1',
        principalKind: 'worker',
        ownerManagerAgentId: 'manager-1',
        revision: 5,
        executionMode: 'secure',
        environmentStatus: 'ready',
        leases: [{
          leaseId: 'worker-lease-1',
          secretId: 'secret-1',
          displayAlias: 'deploy-token',
          policy: { kind: 'task' },
          status: 'active',
          bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
        }],
        pendingRequests: [],
        projectDefaults: [{
          secretId: 'secret-default',
          displayAlias: 'deploy-token',
          state: 'configured',
          statusCode: 'ok',
        }],
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
      onGrant,
      onRevoke,
      onApplyProjectDefaults,
      onReviewProjectSecrets,
    }))

    openPicker(/active with 1 active lease/)
    expect(document.body.textContent).toContain('Worker Secure Status')
    expect(document.body.textContent).toContain(
      'Only its own approved grants are available here.',
    )
    const popover = Array.from(
      document.body.querySelectorAll('[data-slot="popover-content"]'),
    ).find((candidate) => candidate.textContent?.includes('Worker Secure Status'))
    expect(popover).not.toBeNull()
    const actionButtonLabels = Array.from(popover!.querySelectorAll('button'))
      .map((button) => button.textContent ?? '')
      .filter((label) =>
        [
          'Apply now',
          'Review project secrets',
          'Revoke',
          'Grant secrets',
          'Stop processes and revoke',
        ].includes(label))
    expect(actionButtonLabels).toEqual([])
    expect(onGrant).not.toHaveBeenCalled()
    expect(onRevoke).not.toHaveBeenCalled()
    expect(onApplyProjectDefaults).not.toHaveBeenCalled()
    expect(onReviewProjectSecrets).not.toHaveBeenCalled()
  })

  it('attributes quarantined output to the worker and stops that exact principal', () => {
    const onRevoke = vi.fn()
    renderPicker(makeConfig({
      onRevoke,
      teamMembers: [{
        sessionAgentId: 'worker-1',
        displayName: 'Deploy worker',
        snapshot: {
          sessionAgentId: 'worker-1',
          principalKind: 'worker',
          ownerManagerAgentId: 'manager-1',
          revision: 6,
          executionMode: 'secure',
          environmentStatus: 'ready',
          outputState: 'quarantined',
          leases: [],
          pendingRequests: [],
          updatedAt: '2026-07-23T12:00:00.000Z',
        },
      }],
    }))

    openPicker(/Secure session ready/)
    const member = document.body.querySelector<HTMLElement>(
      '[data-secure-team-member="worker-1"]',
    )
    expect(member?.textContent).toContain(
      'Protected output was redacted for Deploy worker.',
    )
    flushSync(() => {
      fireEvent.click(getByRole(member!, 'button', { name: 'Stop secure processes' }))
    })
    expect(onRevoke).toHaveBeenCalledWith(
      'worker-1',
      undefined,
      { stopProcesses: true },
    )
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
