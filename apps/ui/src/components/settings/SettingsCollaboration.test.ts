/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsCollaboration } from './SettingsCollaboration'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const collabApiMock = vi.hoisted(() => ({
  fetchCollaborationStatus: vi.fn(),
  fetchCollaborationMe: vi.fn(),
  changeMyPassword: vi.fn(),
  fetchCollaborationUsers: vi.fn(),
  updateCollaborationUser: vi.fn(),
  resetUserPassword: vi.fn(),
  fetchCollaborationInvites: vi.fn(),
  createCollaborationInvite: vi.fn(),
  revokeCollaborationInvite: vi.fn(),
  isAuthError: vi.fn(),
}))

const endpointsMock = vi.hoisted(() => ({
  collabServerUrl: null as string | null,
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://collab.example.com/',
  getCollabServerUrl: () => endpointsMock.collabServerUrl,
  setCollabServerUrl: (url: string | null) => {
    endpointsMock.collabServerUrl = url
  },
}))

vi.mock('./collaboration-settings-api', () => ({
  fetchCollaborationStatus: (...args: unknown[]) => collabApiMock.fetchCollaborationStatus(...args),
  fetchCollaborationMe: (...args: unknown[]) => collabApiMock.fetchCollaborationMe(...args),
  changeMyPassword: (...args: unknown[]) => collabApiMock.changeMyPassword(...args),
  fetchCollaborationUsers: (...args: unknown[]) => collabApiMock.fetchCollaborationUsers(...args),
  updateCollaborationUser: (...args: unknown[]) => collabApiMock.updateCollaborationUser(...args),
  resetUserPassword: (...args: unknown[]) => collabApiMock.resetUserPassword(...args),
  fetchCollaborationInvites: (...args: unknown[]) => collabApiMock.fetchCollaborationInvites(...args),
  createCollaborationInvite: (...args: unknown[]) => collabApiMock.createCollaborationInvite(...args),
  revokeCollaborationInvite: (...args: unknown[]) => collabApiMock.revokeCollaborationInvite(...args),
  isAuthError: (...args: unknown[]) => collabApiMock.isAuthError(...args),
}))

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

function statusEnabled() {
  return {
    enabled: true,
    adminExists: true,
    baseUrl: 'https://collab.test',
  }
}

function statusDisabled() {
  return { ...statusEnabled(), enabled: false }
}

function adminSession() {
  return {
    authenticated: true,
    user: {
      userId: 'admin-1',
      email: 'admin@test.com',
      name: 'Admin User',
      role: 'admin' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  }
}

function memberSession() {
  return {
    authenticated: true,
    user: {
      userId: 'member-1',
      email: 'member@test.com',
      name: 'Member User',
      role: 'member' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  }
}

function passwordChangeRequiredSession() {
  return {
    ...memberSession(),
    passwordChangeRequired: true,
  }
}

function testUsers() {
  return [
    {
      userId: 'admin-1',
      email: 'admin@test.com',
      name: 'Admin User',
      role: 'admin' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      userId: 'member-1',
      email: 'member@test.com',
      name: 'Regular Member',
      role: 'member' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-02T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
    },
    {
      userId: 'deactivated-1',
      email: 'deactivated@test.com',
      name: 'Deactivated User',
      role: 'member' as const,
      disabled: true,
      authMethods: ['password' as const],
      createdAt: '2025-01-03T00:00:00Z',
      updatedAt: '2025-01-03T00:00:00Z',
    },
  ]
}

function testInvites() {
  return [
    {
      inviteId: 'inv-1',
      email: 'pending@test.com',
      role: 'member' as const,
      status: 'pending' as const,
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-08T00:00:00Z',
    },
    {
      inviteId: 'inv-2',
      email: 'consumed@test.com',
      role: 'member' as const,
      status: 'consumed' as const,
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-08T00:00:00Z',
      consumedAt: '2025-01-02T00:00:00Z',
    },
    {
      inviteId: 'inv-3',
      email: 'revoked@test.com',
      role: 'member' as const,
      status: 'revoked' as const,
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-08T00:00:00Z',
      revokedAt: '2025-01-03T00:00:00Z',
    },
    {
      inviteId: 'inv-4',
      email: 'expired@test.com',
      role: 'member' as const,
      status: 'expired' as const,
      createdAt: '2024-12-01T00:00:00Z',
      expiresAt: '2024-12-08T00:00:00Z',
    },
  ]
}

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  collabApiMock.isAuthError.mockReturnValue(false)
  // Default: remote server configured (so session/management panels appear)
  endpointsMock.collabServerUrl = 'https://collab.example.com'
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  endpointsMock.collabServerUrl = null
})

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
    flushSync(() => {})
  }
}

function renderCollab(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsCollaboration, { wsUrl: 'ws://127.0.0.1:47187' }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsCollaboration', () => {
  /* ---- Status section ---- */

  describe('status display', () => {
    it('shows disabled badge when collab is not enabled', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusDisabled())
      renderCollab()
      await flush()

      expect(container.textContent).toContain('Disabled')
      expect(container.textContent).toContain('FORGE_COLLABORATION_ENABLED=true')
    })

    it('shows enabled badge when collab is active', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      expect(container.textContent).toContain('Enabled')
      expect(container.textContent).toContain('Configured')
    })

    it('shows base URL when available', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      expect(container.textContent).toContain('https://collab.test')
    })

    it('shows error state with retry', async () => {
      collabApiMock.fetchCollaborationStatus.mockRejectedValue(new Error('Connection failed'))
      renderCollab()
      await flush()

      expect(container.textContent).toContain('Connection failed')
      expect(container.textContent).toContain('Retry')
    })
  })

  /* ---- Authentication section (public-specific: sign-in form for remote servers) ---- */

  describe('authentication section', () => {
    it('shows sign-in form when collab is enabled but user is not authenticated', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByText(container, 'Authentication')).toBeTruthy()
      })

      expect(getByLabelText(container, 'Email')).toBeTruthy()
      expect(getByLabelText(container, 'Password')).toBeTruthy()
      expect(getByRole(container, 'button', { name: 'Sign in' })).toBeTruthy()
    })

    it('does not show auth section when collab is disabled', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusDisabled())
      renderCollab()
      await flush()

      await waitFor(() => {
        expect(getByText(container, 'Disabled')).toBeTruthy()
      })

      expect(queryByText(container, 'Authentication')).toBeNull()
    })

    it('shows signed-in state with user info and sign-out button', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByText(container, 'Admin User')).toBeTruthy()
      })
      // admin@test.com appears in both status "Signed in as" and auth section — use queryAll
      const emailElements = container.querySelectorAll('*')
      const emailMatches = Array.from(emailElements).filter(
        (el) => el.textContent === 'admin@test.com' && el.children.length === 0,
      )
      expect(emailMatches.length).toBeGreaterThanOrEqual(1)
      expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
    })

    it('posts sign-in request with email and password', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })

      // Stub global fetch for the raw sign-in POST (which bypasses the API module)
      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/auth/sign-in/email')) {
          return { ok: true, json: async () => ({ success: true }) }
        }
        if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
          return { ok: true, json: async () => adminSession() }
        }
        return { ok: false, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByLabelText(container, 'Email')).toBeTruthy()
      })

      fireEvent.change(getByLabelText(container, 'Email'), { target: { value: 'user@test.com' } })
      fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'secret123' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign in' }))

      await waitFor(() => {
        const signInCall = fetchSpy.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/sign-in/email'),
        ) as unknown[] | undefined
        expect(signInCall).toBeTruthy()
        expect(signInCall![1]).toEqual({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'user@test.com', password: 'secret123' }),
        })
      })
    })

    it('posts sign-out request with JSON body', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/auth/sign-out')) {
          return { ok: true, json: async () => ({}) }
        }
        return { ok: false, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
      })

      fireEvent.click(getByRole(container, 'button', { name: 'Sign out of collaboration server' }))

      await waitFor(() => {
        const signOutCall = fetchSpy.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/sign-out'),
        ) as unknown[] | undefined
        expect(signOutCall).toBeTruthy()
        expect(signOutCall![1]).toEqual({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      })
    })
  })

  /* ---- Admin rendering ---- */

  describe('admin view', () => {
    it('loads session and shows admin panels when authenticated as admin', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      // Current user info
      expect(container.textContent).toContain('Signed in as')
      expect(container.textContent).toContain('admin@test.com')

      // Members section
      expect(container.textContent).toContain('Members')
      expect(container.textContent).toContain('Admin User')
      expect(container.textContent).toContain('Regular Member')
      expect(container.textContent).toContain('Deactivated User')
      expect(container.textContent).toContain('Deactivated')

      // Invites section
      expect(container.textContent).toContain('Invites')
      expect(container.textContent).toContain('pending@test.com')
      expect(container.textContent).toContain('consumed@test.com')

      // Admin calls the admin endpoints
      expect(collabApiMock.fetchCollaborationUsers).toHaveBeenCalled()
      expect(collabApiMock.fetchCollaborationInvites).toHaveBeenCalled()
    })

    it('shows (you) label next to current user in members list', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('(you)')
    })

    it('does NOT show a delete button for any user', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      const allButtons = container.querySelectorAll('button')
      for (const btn of allButtons) {
        expect(btn.textContent?.toLowerCase()).not.toContain('delete')
      }
    })
  })

  /* ---- Member rendering ---- */

  describe('member view', () => {
    it('shows password change form but not admin panels', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('Change Password')
      expect(container.textContent).not.toContain('Manage collaboration team members')
      expect(container.textContent).not.toContain('Invite new members')
    })

    it('does not call admin endpoints for member role', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      expect(collabApiMock.fetchCollaborationUsers).not.toHaveBeenCalled()
      expect(collabApiMock.fetchCollaborationInvites).not.toHaveBeenCalled()
      expect(collabApiMock.resetUserPassword).not.toHaveBeenCalled()
      expect(collabApiMock.updateCollaborationUser).not.toHaveBeenCalled()
      expect(collabApiMock.createCollaborationInvite).not.toHaveBeenCalled()
      expect(collabApiMock.revokeCollaborationInvite).not.toHaveBeenCalled()
    })
  })

  /* ---- Password change required ---- */

  describe('password change required', () => {
    it('shows required password-change banner and hides admin panels', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(passwordChangeRequiredSession())
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('must change your temporary password')
      expect(container.querySelector('[data-testid="members-list"]')).toBeNull()
      expect(container.querySelector('[data-testid="invites-list"]')).toBeNull()
    })
  })

  /* ---- Password form validation ---- */

  describe('password change form', () => {
    it('validates that passwords match and does not fetch', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      expect(form).not.toBeNull()

      const inputs = form.querySelectorAll('input[type="password"]')
      expect(inputs.length).toBe(3)

      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'newpass123' } })
      fireEvent.change(inputs[2]!, { target: { value: 'mismatch99' } })

      fireEvent.submit(form)
      await flush()

      expect(container.textContent).toContain('Passwords do not match')
      expect(collabApiMock.changeMyPassword).not.toHaveBeenCalled()
    })

    it('validates minimum password length', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      const inputs = form.querySelectorAll('input[type="password"]')

      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'short' } })
      fireEvent.change(inputs[2]!, { target: { value: 'short' } })

      fireEvent.submit(form)
      await flush()

      expect(container.textContent).toContain('at least 8 characters')
      expect(collabApiMock.changeMyPassword).not.toHaveBeenCalled()
    })

    it('calls changeMyPassword on valid submission', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      collabApiMock.changeMyPassword.mockResolvedValue(undefined)
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      const inputs = form.querySelectorAll('input[type="password"]')

      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'newpass123' } })
      fireEvent.change(inputs[2]!, { target: { value: 'newpass123' } })

      fireEvent.submit(form)
      await flush()

      expect(collabApiMock.changeMyPassword).toHaveBeenCalledWith('oldpass123', 'newpass123')
    })
  })

  /* ---- Temp password reset ---- */

  describe('admin temp password reset', () => {
    it('renders action buttons for non-self users only', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      const selfRow = container.querySelector('[data-testid="member-row-admin-1"]')!
      expect(selfRow.querySelector('button[aria-label]')).toBeNull()

      const memberRow = container.querySelector('[data-testid="member-row-member-1"]')!
      expect(memberRow.querySelector('button[aria-label]')).not.toBeNull()

      const deactivatedRow = container.querySelector('[data-testid="member-row-deactivated-1"]')!
      expect(deactivatedRow.querySelector('button[aria-label]')).not.toBeNull()
    })

    it('resetUserPassword is not called unless admin explicitly triggers reset', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      expect(collabApiMock.resetUserPassword).not.toHaveBeenCalled()
    })
  })

  /* ---- Invite form validation ---- */

  describe('invite creation', () => {
    it('requires email for invite creation — blank email does not POST', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="create-invite-form"]') as HTMLFormElement
      expect(form).not.toBeNull()

      fireEvent.submit(form)
      await flush()

      expect(container.textContent).toContain('Email is required')
      expect(collabApiMock.createCollaborationInvite).not.toHaveBeenCalled()
    })

    it('shows create response inviteUrl with copy button', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      collabApiMock.createCollaborationInvite.mockResolvedValue({
        inviteId: 'new-inv',
        email: 'new@test.com',
        role: 'member',
        createdAt: '2025-01-10T00:00:00Z',
        expiresAt: '2025-01-17T00:00:00Z',
        inviteUrl: 'https://collab.test/collaboration/invite/abc123',
      })
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="create-invite-form"]') as HTMLFormElement
      const emailInput = form.querySelector('input[type="email"]') as HTMLInputElement
      fireEvent.change(emailInput, { target: { value: 'new@test.com' } })
      fireEvent.submit(form)
      await flush()

      expect(collabApiMock.createCollaborationInvite).toHaveBeenCalledWith('new@test.com')

      const banner = container.querySelector('[data-testid="created-invite-banner"]')
      expect(banner).not.toBeNull()
      expect(banner!.textContent).toContain('https://collab.test/collaboration/invite/abc123')
      expect(banner!.textContent).toContain('Copy link')
    })

    it('shows all invite statuses (pending/consumed/revoked/expired)', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      const text = container.textContent ?? ''
      expect(text).toContain('pending')
      expect(text).toContain('consumed')
      expect(text).toContain('revoked')
      expect(text).toContain('expired')
    })

    it('shows revoke button only for pending invites', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      const invitesList = container.querySelector('[data-testid="invites-list"]')!
      const revokeButtons = invitesList.querySelectorAll('button')
      const revokeTexts = Array.from(revokeButtons).filter(
        (btn) => btn.textContent?.trim() === 'Revoke',
      )
      expect(revokeTexts.length).toBe(1)
    })

    it('revoke calls revokeCollaborationInvite with inviteId', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      collabApiMock.revokeCollaborationInvite.mockResolvedValue(undefined)
      renderCollab()
      await flush()
      await flush()

      const invitesList = container.querySelector('[data-testid="invites-list"]')!
      const revokeBtn = Array.from(invitesList.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Revoke',
      )!
      fireEvent.click(revokeBtn)
      await flush()

      expect(collabApiMock.revokeCollaborationInvite).toHaveBeenCalledWith('inv-1')
    })
  })

  /* ---- Auth error handling ---- */

  describe('auth error handling', () => {
    it('shows auth error banner when backend returns 200 { authenticated: false }', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()
      await flush()

      const errorBanner = container.querySelector('[data-testid="collab-auth-error"]')
      expect(errorBanner).not.toBeNull()
      expect(errorBanner!.textContent).toContain('session has ended')
      expect(errorBanner!.textContent).toContain('Sign in again')
    })

    it('shows auth error banner on thrown 401/403', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      const authErr = new Error('401: Unauthorized') as Error & { status?: number }
      authErr.status = 401
      collabApiMock.fetchCollaborationMe.mockRejectedValue(authErr)
      collabApiMock.isAuthError.mockReturnValue(true)
      renderCollab()
      await flush()
      await flush()

      const errorBanner = container.querySelector('[data-testid="collab-auth-error"]')
      expect(errorBanner).not.toBeNull()
      expect(errorBanner!.textContent).toContain('session has ended')
      expect(errorBanner!.textContent).toContain('Sign in again')
    })
  })

  /* ---- Public-port boundary ---- */

  describe('public-port boundary', () => {
    it('API helpers use collaboration base URL plumbing, not builder wsUrl', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      // fetchCollaborationStatus takes zero arguments — no wsUrl leak
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith()
      // fetchCollaborationMe takes zero arguments
      expect(collabApiMock.fetchCollaborationMe).toHaveBeenCalledWith()
    })
  })
})
