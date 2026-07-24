/** @vitest-environment jsdom */

import {
  fireEvent,
  getByLabelText,
  getByRole,
  waitFor,
} from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureAccessRequestView } from '../secure-session/types'
import { SecureSessionUiError } from '@/lib/secure-sessions-api'
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
    project: { profileId: 'profile-1', displayName: 'Release project' },
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

  it('can approve a matching secret saved while an initially missing request is pending', () => {
    const onGrant = vi.fn()
    renderCard({
      request: { ...request, secretId: undefined },
      onGrant,
    })

    expect(container.textContent).toContain('Approve with saved secret')
    expect(container.textContent).not.toContain('Add secret and approve')
    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Approve' }))
    })

    expect(onGrant).toHaveBeenCalledWith({
      requestId: 'request-1',
      selectForMissingRequest: true,
      secretId: 'secret-1',
      bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
      policy: { kind: 'one_use' },
    })
  })

  it('saves a missing secret to the current project and approves the exact request', async () => {
    const onPrivateFulfill = vi.fn(() => {
      expect(privateValueInputs()[0]?.value).toBe('')
      expect(document.body.textContent).not.toContain('private-value-123')
    })
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'private-value-123' } })
    })
    expect(input.value).toBe('private-value-123')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Add secret and approve' }))
    })

    expect(onPrivateFulfill).toHaveBeenCalledWith('request-1', {
      value: 'private-value-123',
      retention: 'saved',
      scope: { kind: 'profile', profileId: 'profile-1' },
    })
    await waitFor(() => expect(privateValueInputs()).toHaveLength(0))
    expect(document.body.textContent).not.toContain('private-value-123')
    expect(Array.from(document.body.querySelectorAll('input')).some(
      (candidate) => candidate.value === 'private-value-123',
    )).toBe(false)
  })

  it('can save an all-project secret and make it automatic only in the current project', () => {
    const onPrivateFulfill = vi.fn()
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'shared-private-value' } })
      fireEvent.click(getByRole(document.body, 'radio', { name: /All projects/ }))
      fireEvent.click(getByRole(document.body, 'checkbox', {
        name: /Automatically available in Release project/,
      }))
      fireEvent.click(getByRole(document.body, 'button', { name: 'Add secret and approve' }))
    })

    expect(onPrivateFulfill).toHaveBeenCalledWith('request-1', {
      value: 'shared-private-value',
      retention: 'saved',
      scope: { kind: 'instance' },
      makeProjectDefault: true,
    })
  })

  it('keeps save-and-approve available when the project-default limit is reached', () => {
    const onPrivateFulfill = vi.fn()
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      project: {
        profileId: 'profile-1',
        displayName: 'Release project',
        projectDefaultLimitReached: true,
      },
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const automaticCheckbox = getByRole(document.body, 'checkbox', {
      name: /Automatically available in Release project/,
    }) as HTMLInputElement
    expect(automaticCheckbox.disabled).toBe(true)
    expect(document.body.textContent).toContain(
      'This project already has 16 automatic secrets',
    )

    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'saved-without-default' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Add secret and approve' }))
    })

    expect(onPrivateFulfill).toHaveBeenCalledWith('request-1', {
      value: 'saved-without-default',
      retention: 'saved',
      scope: { kind: 'profile', profileId: 'profile-1' },
    })
  })

  it('can use a missing value without saving it to the catalog', () => {
    const onPrivateFulfill = vi.fn()
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'ephemeral-private-value' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Use for this task only' }))
    })

    expect(onPrivateFulfill).toHaveBeenCalledWith('request-1', {
      value: 'ephemeral-private-value',
      retention: 'session',
      scope: { kind: 'profile', profileId: 'profile-1' },
    })
  })

  it('clears and unmounts a private value immediately on cancel', () => {
    const onPrivateFulfill = vi.fn()
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
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

  it('removes a private value when the active task surface unmounts', () => {
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'unmounted-private-value' } })
      root.render(createElement('div'))
    })

    expect(privateValueInputs()).toHaveLength(0)
    expect(input.value).toBe('')
    expect(document.body.textContent).not.toContain('unmounted-private-value')
  })

  it('keeps a failed request actionable and displays the fixed failure', async () => {
    const onPrivateFulfill = vi.fn(async () => {
      throw new SecureSessionUiError('SECURE_STALE_REVISION')
    })
    renderCard({
      request: { ...request, secretId: undefined },
      secrets: [],
      onPrivateFulfill,
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'failed-private-value' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Add secret and approve' }))
    })

    await waitFor(() => {
      expect(getByRole(document.body, 'alert').textContent).toContain(
        'Secure session access changed elsewhere',
      )
    })
    expect(privateValueInputs()).toHaveLength(1)
    expect(privateValueInputs()[0]?.value).toBe('')
    expect(document.body.textContent).not.toContain('failed-private-value')
    expect((
      getByRole(document.body, 'button', {
        name: 'Add secret and approve',
      }) as HTMLButtonElement
    ).disabled).toBe(true)
  })

  it('does not submit an enclosing chat composer while fulfilling a request', () => {
    const composerSubmit = vi.fn((event: Event) => event.preventDefault())
    const onPrivateFulfill = vi.fn()
    const props = {
      request: { ...request, secretId: undefined },
      availability: { state: 'available' as const },
      secrets: [],
      project: { profileId: 'profile-1', displayName: 'Release project' },
      onGrant: vi.fn(),
      onDeny: vi.fn(),
      onPrivateFulfill,
    }
    flushSync(() => {
      root.render(createElement(
        'form',
        { onSubmit: composerSubmit },
        createElement(SecureSecretRequestCard, props),
      ))
    })

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Add secret and approve' }))
    })
    const input = getByLabelText(document.body, 'Value for deploy-token') as HTMLInputElement
    flushSync(() => {
      fireEvent.change(input, { target: { value: 'private-value-123' } })
      fireEvent.click(getByRole(document.body, 'button', { name: 'Add secret and approve' }))
    })

    expect(onPrivateFulfill).toHaveBeenCalledTimes(1)
    expect(composerSubmit).not.toHaveBeenCalled()
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
    expect(container.textContent).not.toContain('Add secret and approve')
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
    expect(getByRole(container, 'button', { name: 'Add secret and approve' })).toBeTruthy()
    expect(container.textContent).not.toContain('Approve with saved secret')
  })
})
