/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, getByText, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsCollaboration } from './SettingsCollaboration'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

vi.mock('@/lib/collaboration-endpoints', () => {
  let storedUrl: string | null = 'https://collab.example.com'
  return {
    getCollabServerUrl: () => storedUrl,
    setCollabServerUrl: (url: string | null) => { storedUrl = url },
    resolveCollaborationApiBaseUrl: () => storedUrl ?? 'http://127.0.0.1:47187/',
  }
})

let root: Root
let container: HTMLDivElement

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Renders the component and waits for the initial status fetch to resolve. */
async function renderWithStatus(statusPayload: object, sessionPayload?: object) {
  const fetchSpy = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/collaboration/status')) {
      return { ok: true, json: async () => statusPayload }
    }
    if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
      if (sessionPayload) {
        return { ok: true, json: async () => sessionPayload }
      }
      return { ok: false, json: async () => ({}) }
    }
    if (typeof url === 'string' && url.includes('/api/auth/sign-in/email')) {
      return { ok: true, json: async () => ({ success: true }) }
    }
    if (typeof url === 'string' && url.includes('/api/auth/sign-out')) {
      return { ok: true, json: async () => ({}) }
    }
    return { ok: false, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchSpy)

  flushSync(() => {
    root.render(createElement(SettingsCollaboration, { wsUrl: 'ws://127.0.0.1:47187' }))
  })

  return fetchSpy
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsCollaboration — Authentication section', () => {
  it('shows sign-in form when collab is enabled but user is not authenticated', async () => {
    await renderWithStatus(
      { enabled: true, adminExists: true },
      { authenticated: false },
    )

    await waitFor(() => {
      expect(getByText(container, 'Authentication')).toBeTruthy()
    })

    // Email and password fields should be visible
    expect(getByLabelText(container, 'Email')).toBeTruthy()
    expect(getByLabelText(container, 'Password')).toBeTruthy()
    expect(getByRole(container, 'button', { name: 'Sign in' })).toBeTruthy()
  })

  it('does not show auth section when collab is disabled', async () => {
    await renderWithStatus({ enabled: false, adminExists: false })

    // Wait for status to load
    await waitFor(() => {
      expect(getByText(container, 'Disabled')).toBeTruthy()
    })

    expect(queryByText(container, 'Authentication')).toBeNull()
  })

  it('shows signed-in state with user info and sign-out button', async () => {
    await renderWithStatus(
      { enabled: true, adminExists: true },
      {
        authenticated: true,
        user: {
          userId: 'user-1',
          email: 'admin@test.com',
          name: 'Admin User',
          role: 'admin',
          disabled: false,
          authMethods: ['password'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      },
    )

    await waitFor(() => {
      expect(getByText(container, 'Admin User')).toBeTruthy()
    })
    expect(getByText(container, 'admin@test.com')).toBeTruthy()
    expect(getByText(container, 'admin')).toBeTruthy()
    expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
  })

  it('posts sign-in request with email and password', async () => {
    const fetchSpy = await renderWithStatus(
      { enabled: true, adminExists: true },
      { authenticated: false },
    )

    await waitFor(() => {
      expect(getByLabelText(container, 'Email')).toBeTruthy()
    })

    const emailInput = getByLabelText(container, 'Email') as HTMLInputElement
    const passwordInput = getByLabelText(container, 'Password') as HTMLInputElement
    const signInButton = getByRole(container, 'button', { name: 'Sign in' })

    fireEvent.change(emailInput, { target: { value: 'user@test.com' } })
    fireEvent.change(passwordInput, { target: { value: 'secret123' } })
    fireEvent.click(signInButton)

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

  it('shows error message on sign-in failure', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/collaboration/status')) {
        return { ok: true, json: async () => ({ enabled: true, adminExists: true }) }
      }
      if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
        return { ok: true, json: async () => ({ authenticated: false }) }
      }
      if (typeof url === 'string' && url.includes('/api/auth/sign-in/email')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: 'Invalid credentials' }),
        }
      }
      return { ok: false, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchSpy)

    flushSync(() => {
      root.render(createElement(SettingsCollaboration, { wsUrl: 'ws://127.0.0.1:47187' }))
    })

    await waitFor(() => {
      expect(getByLabelText(container, 'Email')).toBeTruthy()
    })

    fireEvent.change(getByLabelText(container, 'Email'), { target: { value: 'bad@test.com' } })
    fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'wrong' } })
    fireEvent.click(getByRole(container, 'button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(getByText(container, 'Invalid credentials')).toBeTruthy()
    })
  })

  it('posts sign-out request with JSON body', async () => {
    const fetchSpy = await renderWithStatus(
      { enabled: true, adminExists: true },
      {
        authenticated: true,
        user: {
          userId: 'user-1',
          email: 'admin@test.com',
          name: 'Admin User',
          role: 'admin',
          disabled: false,
          authMethods: ['password'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      },
    )

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
