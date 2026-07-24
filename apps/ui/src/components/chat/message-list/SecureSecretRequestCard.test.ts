/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureAccessRequestView } from '../secure-session/types'
import { SecureSecretRequestCard } from './SecureSecretRequestCard'

let container: HTMLDivElement
let root: Root

const request: SecureAccessRequestView = {
  requestId: 'request-1',
  requestedByAgentId: 'worker-1',
  requestedByLabel: 'Deploy worker',
  secretId: 'secret-1',
  secretAlias: 'deploy-token',
  purpose: 'Publish the verified release',
  requestedBindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
  requestedPolicy: { kind: 'one_use' },
  status: 'pending',
}

const secrets = [{
  secretId: 'secret-1',
  displayAlias: 'deploy-token',
  displayName: 'Deploy token',
  available: true,
  bindings: [{ kind: 'env' as const, variable: 'DEPLOY_TOKEN' }],
}]

function renderCard(overrides: Record<string, unknown> = {}) {
  const props = {
    request,
    availability: { state: 'available' as const },
    secrets,
    onGrant: vi.fn(),
    onDeny: vi.fn(),
    onPrivateFulfill: vi.fn(),
    ...overrides,
  }
  flushSync(() => {
    root.render(createElement(SecureSecretRequestCard, props))
  })
  return props
}

function privateValueInputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="password"]'))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('SecureSecretRequestCard', () => {
  it('approves only the requested binding and scope from a compatible saved alias', () => {
    const onGrant = vi.fn()
    renderCard({ onGrant })

    expect(container.textContent).toContain('Publish the verified release')
    expect(container.textContent).toContain('Environment variable DEPLOY_TOKEN')
    expect(container.textContent).toContain('Next Secure Bash command')
    expect(container.textContent).toContain('requesting worker does not receive')

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Approve' }))
    })

    expect(onGrant).toHaveBeenCalledWith({
      requestId: 'request-1',
      secretId: 'secret-1',
      bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
      policy: { kind: 'one_use' },
    })
  })

  it('clears and unmounts a one-time private value immediately after submit', () => {
    const onPrivateFulfill = vi.fn(() => {
      expect(privateValueInputs()).toHaveLength(0)
      expect(document.body.textContent).not.toContain('private-value-123')
    })
    renderCard({ request: { ...request, secretId: undefined }, onPrivateFulfill })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Provide unsaved value' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'private-value-123' } })
    })
    expect(input.value).toBe('private-value-123')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Approve and provide' }))
    })

    expect(onPrivateFulfill).toHaveBeenCalledWith('request-1', 'private-value-123')
    expect(privateValueInputs()).toHaveLength(0)
    expect(document.body.textContent).not.toContain('private-value-123')
    expect(Array.from(document.body.querySelectorAll('input')).some(
      (candidate) => candidate.value === 'private-value-123',
    )).toBe(false)
  })

  it('clears and unmounts a one-time private value immediately on cancel', () => {
    const onPrivateFulfill = vi.fn()
    renderCard({ request: { ...request, secretId: undefined }, onPrivateFulfill })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Provide unsaved value' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'cancelled-private-value' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Cancel' }))
    })

    expect(onPrivateFulfill).not.toHaveBeenCalled()
    expect(privateValueInputs()).toHaveLength(0)
    expect(document.body.textContent).not.toContain('cancelled-private-value')
    expect(Array.from(document.body.querySelectorAll('input')).some(
      (candidate) => candidate.value === 'cancelled-private-value',
    )).toBe(false)
  })

  it('keeps denial available when the runtime or remote origin cannot securely fulfill', () => {
    const onDeny = vi.fn()
    renderCard({
      availability: {
        state: 'remote_origin',
        reason: 'This project is connected through another Forge host.',
      },
      onDeny,
    })

    expect(container.textContent).toContain('Remote origin')
    expect(container.textContent).toContain('another Forge host')
    expect(container.textContent).not.toContain('Provide unsaved value')
    expect(container.querySelector('button')?.textContent).toBe('Deny')

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Deny' }))
    })
    expect(onDeny).toHaveBeenCalledWith('request-1')
  })

  it('allows ephemeral fulfillment while the saved-secret source is unavailable', () => {
    renderCard({
      request: { ...request, secretId: undefined },
      availability: { state: 'source_unavailable' },
      secrets: [],
    })

    expect(container.textContent).toContain('Secret source unavailable')
    expect(getByRole(container, 'button', { name: 'Provide unsaved value' })).toBeTruthy()
    expect(container.textContent).not.toContain('Approve with saved secret')
  })
})
