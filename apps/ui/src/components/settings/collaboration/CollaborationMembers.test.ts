/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole } from '@testing-library/dom'
import { createElement, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const apiMock = vi.hoisted(() => ({
  fetchCollaborationUsers: vi.fn(),
  updateCollaborationUser: vi.fn(),
  resetUserPassword: vi.fn(),
  isAuthError: vi.fn(() => false),
}))

vi.mock('../collaboration-settings-api', () => ({
  fetchCollaborationUsers: (...args: Parameters<typeof apiMock.fetchCollaborationUsers>) => apiMock.fetchCollaborationUsers(...args),
  updateCollaborationUser: (...args: Parameters<typeof apiMock.updateCollaborationUser>) => apiMock.updateCollaborationUser(...args),
  resetUserPassword: (...args: Parameters<typeof apiMock.resetUserPassword>) => apiMock.resetUserPassword(...args),
  isAuthError: (...args: Parameters<typeof apiMock.isAuthError>) => apiMock.isAuthError(...args),
}))

// Mock Radix DropdownMenu — jsdom cannot render the portal-based menus.
// Render items as plain buttons so test clicks work.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => createElement('div', { 'data-testid': 'dropdown' }, children),
  DropdownMenuTrigger: ({ children }: PropsWithChildren & { asChild?: boolean }) => children,
  DropdownMenuContent: ({ children }: PropsWithChildren) => createElement('div', { role: 'menu' }, children),
  DropdownMenuItem: ({ children, onClick, className }: PropsWithChildren & { onClick?: () => void; className?: string }) =>
    createElement('button', { type: 'button', role: 'menuitem', onClick, className }, children),
  DropdownMenuSeparator: () => createElement('hr'),
}))

// Mock Radix Dialog — password reset dialog uses portal rendering.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: PropsWithChildren & { open?: boolean }) =>
    open ? createElement('div', { 'data-testid': 'dialog-root' }, children) : null,
  DialogContent: ({ children, ...rest }: PropsWithChildren & Record<string, unknown>) =>
    createElement('div', rest, children),
  DialogHeader: ({ children }: PropsWithChildren) => createElement('div', null, children),
  DialogTitle: ({ children }: PropsWithChildren) => createElement('h2', null, children),
  DialogDescription: ({ children }: PropsWithChildren) => createElement('p', null, children),
  DialogFooter: ({ children }: PropsWithChildren) => createElement('div', null, children),
}))

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

function usersA() {
  return [
    { userId: 'a-admin', email: 'admin-a@test.com', name: 'Admin A', role: 'admin' as const, disabled: false, authMethods: ['password' as const], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    { userId: 'a-member', email: 'member-a@test.com', name: 'Member A', role: 'member' as const, disabled: false, authMethods: ['password' as const], createdAt: '2025-01-02T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z' },
  ]
}

function usersB() {
  return [
    { userId: 'b-admin', email: 'admin-b@test.com', name: 'Admin B', role: 'admin' as const, disabled: false, authMethods: ['password' as const], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
  ]
}

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

// Lazy import to let mocks register first
let CollaborationMembers: typeof import('./CollaborationMembers').CollaborationMembers

beforeEach(async () => {
  const mod = await import('./CollaborationMembers')
  CollaborationMembers = mod.CollaborationMembers
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
    root!.render(createElement(CollaborationMembers, {
      currentUserId: 'a-admin',
      apiBaseUrl,
    }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('CollaborationMembers — stale-request race protection', () => {
  it('late-resolving users for backend A do not overwrite state after switching to backend B', async () => {
    // Backend A: slow
    let resolveUsersA: ((v: unknown[]) => void) | null = null
    const slowA = new Promise<unknown[]>((resolve) => { resolveUsersA = resolve })
    apiMock.fetchCollaborationUsers.mockImplementationOnce(() => slowA)

    // Initial render with backend A
    render('https://server-a.test/')
    await flush()

    // Still loading (A hasn't resolved)
    expect(container.textContent).toContain('Loading members')

    // Switch to backend B (fast)
    apiMock.fetchCollaborationUsers.mockResolvedValue(usersB())
    render('https://server-b.test/')
    await flush()
    await flush()

    // Backend B's users should be showing
    expect(container.textContent).toContain('Admin B')
    expect(container.textContent).not.toContain('Member A')

    // Now resolve stale A — must NOT overwrite B's state
    resolveUsersA!(usersA())
    await flush()
    await flush()

    // UI must still show B's user, not A's stale data
    expect(container.textContent).toContain('Admin B')
    expect(container.textContent).not.toContain('Admin A')
    expect(container.textContent).not.toContain('Member A')
  })

  it('passes abort signal to fetchCollaborationUsers and aborts on switch', async () => {
    // Track the signal passed to each call
    const capturedSignals: AbortSignal[] = []
    apiMock.fetchCollaborationUsers.mockImplementation((_url: string, signal?: AbortSignal) => {
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

  it('resets user list on apiBaseUrl change before loading new data', async () => {
    // Backend A: resolves fast
    apiMock.fetchCollaborationUsers.mockResolvedValueOnce(usersA())
    render('https://server-a.test/')
    await flush()
    await flush()

    expect(container.textContent).toContain('Admin A')
    expect(container.textContent).toContain('Member A')

    // Switch to B: slow
    apiMock.fetchCollaborationUsers.mockImplementation(() => new Promise(() => {}))
    render('https://server-b.test/')
    await flush()

    // A's data should be cleared while B is loading
    expect(container.textContent).not.toContain('Admin A')
    expect(container.textContent).not.toContain('Member A')
    expect(container.textContent).toContain('Loading members')
  })

  it('late role-change for backend A does not update users on backend B', async () => {
    // Backend A: fast load, slow role change
    apiMock.fetchCollaborationUsers.mockResolvedValueOnce(usersA())

    let resolveRoleChange: ((v: unknown) => void) | null = null
    const slowRoleChange = new Promise<unknown>((resolve) => { resolveRoleChange = resolve })
    apiMock.updateCollaborationUser.mockImplementationOnce(() => slowRoleChange)

    render('https://server-a.test/')
    await flush()
    await flush()

    // With mocked dropdown, menu items render inline as buttons.
    // Click "Promote to Admin" on Member A.
    const memberRow = container.querySelector('[data-testid="member-row-a-member"]') as HTMLElement
    const promoteBtn = getByRole(memberRow, 'menuitem', { name: 'Promote to Admin' })
    fireEvent.click(promoteBtn)
    await flush()

    // Switch to B before A's role change resolves
    apiMock.fetchCollaborationUsers.mockResolvedValue(usersB())
    render('https://server-b.test/')
    await flush()
    await flush()

    expect(container.textContent).toContain('Admin B')

    // Resolve stale A role change
    const promotedA = { ...usersA()[1], role: 'admin' }
    resolveRoleChange!(promotedA)
    await flush()
    await flush()

    // B must still show only its own data
    expect(container.textContent).toContain('Admin B')
    expect(container.textContent).not.toContain('Member A')
    expect(container.textContent).not.toContain('Admin A')
  })

  it('late deactivate for backend A does not update users on backend B', async () => {
    apiMock.fetchCollaborationUsers.mockResolvedValueOnce(usersA())

    let resolveToggle: ((v: unknown) => void) | null = null
    const slowToggle = new Promise<unknown>((resolve) => { resolveToggle = resolve })
    apiMock.updateCollaborationUser.mockImplementationOnce(() => slowToggle)

    render('https://server-a.test/')
    await flush()
    await flush()

    // Click "Deactivate" on Member A
    const memberRow = container.querySelector('[data-testid="member-row-a-member"]') as HTMLElement
    const deactivateBtn = getByRole(memberRow, 'menuitem', { name: 'Deactivate' })
    fireEvent.click(deactivateBtn)
    await flush()

    // Switch to B
    apiMock.fetchCollaborationUsers.mockResolvedValue(usersB())
    render('https://server-b.test/')
    await flush()
    await flush()

    // Resolve stale A toggle
    const deactivatedA = { ...usersA()[1], disabled: true }
    resolveToggle!(deactivatedA)
    await flush()
    await flush()

    // B must not show A's data or error
    expect(container.textContent).toContain('Admin B')
    expect(container.textContent).not.toContain('Member A')
  })

  it('late password reset for backend A does not update state on backend B', async () => {
    apiMock.fetchCollaborationUsers.mockResolvedValueOnce(usersA())

    let resolveReset: (() => void) | null = null
    const slowReset = new Promise<void>((resolve) => { resolveReset = resolve })
    apiMock.resetUserPassword.mockImplementationOnce(() => slowReset)

    render('https://server-a.test/')
    await flush()
    await flush()

    // Click "Reset password" on Member A to open the dialog
    const memberRow = container.querySelector('[data-testid="member-row-a-member"]') as HTMLElement
    const resetMenuItem = getByRole(memberRow, 'menuitem', { name: 'Reset password' })
    fireEvent.click(resetMenuItem)
    await flush()

    // Fill and submit reset dialog (mocked Dialog renders inline)
    const dialog = container.querySelector('[data-testid="password-reset-dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()

    const tempInput = getByLabelText(dialog, 'Temporary password')
    const confirmInput = getByLabelText(dialog, 'Confirm password')
    fireEvent.change(tempInput, { target: { value: 'temppass123' } })
    fireEvent.change(confirmInput, { target: { value: 'temppass123' } })

    const resetBtn = getByRole(dialog, 'button', { name: 'Reset password' })
    fireEvent.click(resetBtn)
    await flush()

    // Switch to B before reset resolves
    apiMock.fetchCollaborationUsers.mockResolvedValue(usersB())
    render('https://server-b.test/')
    await flush()
    await flush()

    // Resolve stale A reset
    resolveReset!()
    await flush()
    await flush()

    // B must show its own data; no stale dialog/state leak
    expect(container.textContent).toContain('Admin B')
    expect(container.textContent).not.toContain('Member A')
  })
})
