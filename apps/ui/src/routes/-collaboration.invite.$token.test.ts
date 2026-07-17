/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationInvitePage } from './collaboration.invite.$token'

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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
    flushSync(() => {})
  }
}

function renderInvite(onRedeemed = vi.fn()) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(CollaborationInvitePage, { token: 'invite-token', onRedeemed }))
  })
  return onRedeemed
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
}

describe('CollaborationInvitePage', () => {
  it('renders a valid invite and redeems it, then signs in', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlString = String(url)
      if (urlString === '/api/collaboration/invites/invite-token' && !init?.method) {
        return jsonResponse({
          valid: true,
          invite: {
            inviteId: 'inv-1',
            email: 'member@example.com',
            role: 'member',
            expiresAt: '2026-01-08T00:00:00Z',
          },
        })
      }
      if (urlString === '/api/collaboration/invites/invite-token/redeem') {
        return jsonResponse({ ok: true, user: { userId: 'u1', email: 'member@example.com', name: 'Member User', role: 'member' } })
      }
      if (urlString === '/api/auth/sign-in/email') {
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ error: 'unexpected url' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onRedeemed = renderInvite()

    await waitFor(() => {
      expect(container.textContent).toContain('member@example.com')
    })
    expect(container.textContent).toContain('member')
    const email = getByLabelText(container, 'Email') as HTMLInputElement
    expect(email.value).toBe('member@example.com')
    expect(email.disabled).toBe(true)

    fireEvent.change(getByLabelText(container, 'Display name'), { target: { value: 'Member User' } })
    fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'secure-password' } })
    fireEvent.click(getByRole(container, 'button', { name: 'Accept invite' }))
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/collaboration/invites/invite-token/redeem', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'member@example.com', name: 'Member User', password: 'secure-password' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-in/email', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'member@example.com', password: 'secure-password' }),
    }))
    expect(onRedeemed).toHaveBeenCalledWith({ signedIn: true })
  })

  it('shows an invalid invite state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ valid: false, error: 'expired' })))
    renderInvite()

    await waitFor(() => {
      expect(container.textContent).toContain('Invite unavailable')
    })
    expect(container.textContent).toContain('This invite has expired')
    expect(queryByText(container, 'Accept invite')).toBeNull()
  })
})
