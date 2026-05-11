/** @vitest-environment jsdom */

import { fireEvent, getByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const apiMock = vi.hoisted(() => ({
  fetchCollaborationInvites: vi.fn(),
  createCollaborationInvite: vi.fn(),
  revokeCollaborationInvite: vi.fn(),
  isAuthError: vi.fn(() => false),
}))

vi.mock('../collaboration-settings-api', () => ({
  fetchCollaborationInvites: (...args: Parameters<typeof apiMock.fetchCollaborationInvites>) => apiMock.fetchCollaborationInvites(...args),
  createCollaborationInvite: (...args: Parameters<typeof apiMock.createCollaborationInvite>) => apiMock.createCollaborationInvite(...args),
  revokeCollaborationInvite: (...args: Parameters<typeof apiMock.revokeCollaborationInvite>) => apiMock.revokeCollaborationInvite(...args),
  isAuthError: (...args: Parameters<typeof apiMock.isAuthError>) => apiMock.isAuthError(...args),
}))

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

function invitesA() {
  return [
    { inviteId: 'inv-a1', email: 'user-a@test.com', role: 'member' as const, status: 'pending' as const, createdAt: '2025-01-01T00:00:00Z', expiresAt: '2025-01-08T00:00:00Z' },
    { inviteId: 'inv-a2', email: 'user-a2@test.com', role: 'member' as const, status: 'consumed' as const, createdAt: '2025-01-01T00:00:00Z', expiresAt: '2025-01-08T00:00:00Z', consumedAt: '2025-01-02T00:00:00Z' },
  ]
}

function invitesB() {
  return [
    { inviteId: 'inv-b1', email: 'user-b@test.com', role: 'member' as const, status: 'pending' as const, createdAt: '2025-02-01T00:00:00Z', expiresAt: '2025-02-08T00:00:00Z' },
  ]
}

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let CollaborationInvites: typeof import('./CollaborationInvites').CollaborationInvites

beforeEach(async () => {
  const mod = await import('./CollaborationInvites')
  CollaborationInvites = mod.CollaborationInvites
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
    flushSync(() => {})
  }
}

function render(apiBaseUrl: string) {
  if (!root) root = createRoot(container)
  flushSync(() => {
    root!.render(createElement(CollaborationInvites, { apiBaseUrl }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('CollaborationInvites — stale-request race protection', () => {
  it('late-resolving invites for backend A do not overwrite state after switching to backend B', async () => {
    // Backend A: slow
    let resolveInvitesA: ((v: unknown[]) => void) | null = null
    const slowA = new Promise<unknown[]>((resolve) => { resolveInvitesA = resolve })
    apiMock.fetchCollaborationInvites.mockImplementationOnce(() => slowA)

    // Initial render with backend A
    render('https://server-a.test/')
    await flush()

    // Still loading (A hasn't resolved)
    expect(container.textContent).toContain('Loading invites')

    // Switch to backend B (fast)
    apiMock.fetchCollaborationInvites.mockResolvedValue(invitesB())
    render('https://server-b.test/')
    await flush()
    await flush()

    // Backend B's invites should be showing
    expect(container.textContent).toContain('user-b@test.com')
    expect(container.textContent).not.toContain('user-a@test.com')

    // Now resolve stale A — must NOT overwrite B's state
    resolveInvitesA!(invitesA())
    await flush()
    await flush()

    // UI must still show B's invite, not A's stale data
    expect(container.textContent).toContain('user-b@test.com')
    expect(container.textContent).not.toContain('user-a@test.com')
    expect(container.textContent).not.toContain('user-a2@test.com')
  })

  it('passes abort signal to fetchCollaborationInvites and aborts on switch', async () => {
    const capturedSignals: AbortSignal[] = []
    apiMock.fetchCollaborationInvites.mockImplementation((_url: string, signal?: AbortSignal) => {
      if (signal) capturedSignals.push(signal)
      return new Promise(() => {}) // never resolves
    })

    render('https://server-a.test/')
    await flush()

    expect(capturedSignals.length).toBeGreaterThanOrEqual(1)
    const signalA = capturedSignals[0]!
    expect(signalA.aborted).toBe(false)

    // Switch to backend B — A's signal should be aborted
    render('https://server-b.test/')
    await flush()

    expect(signalA.aborted).toBe(true)
    // B's signal should still be active
    const signalB = capturedSignals[capturedSignals.length - 1]!
    expect(signalB.aborted).toBe(false)
  })

  it('resets invite list on apiBaseUrl change before loading new data', async () => {
    // Backend A: resolves fast
    apiMock.fetchCollaborationInvites.mockResolvedValueOnce(invitesA())
    render('https://server-a.test/')
    await flush()
    await flush()

    expect(container.textContent).toContain('user-a@test.com')
    expect(container.textContent).toContain('user-a2@test.com')

    // Switch to B: slow
    apiMock.fetchCollaborationInvites.mockImplementation(() => new Promise(() => {}))
    render('https://server-b.test/')
    await flush()

    // A's data should be cleared while B is loading
    expect(container.textContent).not.toContain('user-a@test.com')
    expect(container.textContent).not.toContain('user-a2@test.com')
    expect(container.textContent).toContain('Loading invites')
  })

  it('late invite create from backend A does not set createdInvite or reload on backend B', async () => {
    // Backend A: fast load, slow create
    apiMock.fetchCollaborationInvites.mockResolvedValueOnce(invitesA())

    let resolveCreate: ((v: unknown) => void) | null = null
    const slowCreate = new Promise<unknown>((resolve) => { resolveCreate = resolve })
    apiMock.createCollaborationInvite.mockImplementationOnce(() => slowCreate)

    render('https://server-a.test/')
    await flush()
    await flush()

    // Fill and submit create form
    const form = container.querySelector('[data-testid="create-invite-form"]') as HTMLFormElement
    const emailInput = form.querySelector('input[type="email"]') as HTMLInputElement
    fireEvent.change(emailInput, { target: { value: 'new@a.test' } })
    fireEvent.submit(form)
    await flush()

    // Switch to B before create resolves
    apiMock.fetchCollaborationInvites.mockResolvedValue(invitesB())
    render('https://server-b.test/')
    await flush()
    await flush()

    expect(container.textContent).toContain('user-b@test.com')

    // Resolve stale A create
    resolveCreate!({
      inviteId: 'inv-new-a',
      email: 'new@a.test',
      role: 'member',
      createdAt: '2025-03-01T00:00:00Z',
      expiresAt: '2025-03-08T00:00:00Z',
      inviteUrl: 'https://server-a.test/invite/new',
    })
    await flush()
    await flush()

    // B must not show A's created invite banner
    expect(container.querySelector('[data-testid="created-invite-banner"]')).toBeNull()
    // B must still show its own data
    expect(container.textContent).toContain('user-b@test.com')
    expect(container.textContent).not.toContain('new@a.test')
  })

  it('late invite revoke from backend A does not update invites on backend B', async () => {
    // Backend A: fast load
    apiMock.fetchCollaborationInvites.mockResolvedValueOnce(invitesA())

    let resolveRevoke: (() => void) | null = null
    const slowRevoke = new Promise<void>((resolve) => { resolveRevoke = resolve })
    apiMock.revokeCollaborationInvite.mockImplementationOnce(() => slowRevoke)

    render('https://server-a.test/')
    await flush()
    await flush()

    // Click revoke on the pending invite from A
    const revokeBtn = await waitFor(() => getByRole(container, 'button', { name: 'Revoke' }))
    fireEvent.click(revokeBtn)
    await flush()

    // Switch to B before revoke resolves
    apiMock.fetchCollaborationInvites.mockResolvedValue(invitesB())
    render('https://server-b.test/')
    await flush()
    await flush()

    expect(container.textContent).toContain('user-b@test.com')

    // Resolve stale A revoke
    resolveRevoke!()
    await flush()
    await flush()

    // B must still show its own pending invite (not revoked)
    expect(container.textContent).toContain('user-b@test.com')
    // The pending badge should still be visible (not replaced with "revoked")
    const inviteRow = container.querySelector('[data-testid="invite-row-inv-b1"]')
    expect(inviteRow).not.toBeNull()
    expect(inviteRow!.textContent).toContain('pending')
    expect(inviteRow!.textContent).not.toContain('revoked')
  })
})
