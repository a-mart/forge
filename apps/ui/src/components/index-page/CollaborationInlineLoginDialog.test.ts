/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationInlineLoginDialog } from './CollaborationInlineLoginDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // React 19 requires this marker for DOM events that resolve async state.
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function render(onAuthenticated = vi.fn()) {
  act(() => {
    root.render(createElement(CollaborationInlineLoginDialog, {
      apiBaseUrl: 'https://collab.example.com/',
      onAuthenticated,
    }))
  })
  return onAuthenticated
}

function submit(email = 'member@example.com', password = 'correct-password') {
  fireEvent.change(getByLabelText(document.body, 'Email'), { target: { value: email } })
  fireEvent.change(getByLabelText(document.body, 'Password'), { target: { value: password } })
  fireEvent.click(getByRole(document.body, 'button', { name: 'Sign in' }))
}

describe('CollaborationInlineLoginDialog', () => {
  it('signs in with a persistent credentialed cookie, verifies the session, then reconnects the requested surface', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onAuthenticated = render()

    submit()

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://collab.example.com/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correct-password', rememberMe: true }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://collab.example.com/api/collaboration/me', {
      credentials: 'include',
    })
  })

  it('has no close affordance and disables credentials while sign-in is pending', async () => {
    let resolveSignIn: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveSignIn = resolve
    })))
    render()

    expect(document.body.querySelector('[aria-label="Close"]')).toBeNull()
    submit()

    await waitFor(() => {
      expect((getByLabelText(document.body, 'Email') as HTMLInputElement).disabled).toBe(true)
      expect((getByLabelText(document.body, 'Password') as HTMLInputElement).disabled).toBe(true)
    })

    resolveSignIn?.(new Response(JSON.stringify({ message: 'Invalid email or password' }), { status: 401 }))
    await waitFor(() => expect(getByRole(document.body, 'alert').textContent).toContain('Invalid email or password'))
  })

  it('keeps the dialog open and shows invalid credentials without navigating away', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Invalid email or password' }), { status: 401 })))
    const onAuthenticated = render()

    submit()

    await waitFor(() => expect(getByRole(document.body, 'alert').textContent).toContain('Invalid email or password'))
    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Settings')
  })

  it('shows a clear network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')))
    render()

    submit()

    await waitFor(() => expect(getByRole(document.body, 'alert').textContent).toContain('Network unavailable'))
  })
})
