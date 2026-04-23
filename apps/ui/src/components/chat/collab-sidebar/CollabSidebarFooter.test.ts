/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollabSidebarFooter } from './CollabSidebarFooter'

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

describe('CollabSidebarFooter', () => {
  it('posts JSON sign-out requests so Better Auth clears the session cookie', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchSpy)
    const reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        reload: reloadSpy,
      },
    })

    flushSync(() => {
      root.render(
        createElement(CollabSidebarFooter, {
          wsUrl: 'ws://127.0.0.1:47387',
          currentUser: {
            userId: 'user-1',
            email: 'admin@test.com',
            name: 'Administrator',
            role: 'admin',
            disabled: false,
          },
        }),
      )
    })

    // Open the user popover by clicking the avatar/name trigger
    const trigger = getByText(container, 'Administrator')
    fireEvent.click(trigger.closest('button')!)

    // The popover renders in a portal — search the whole document for the sign-out button
    await waitFor(() => {
      expect(getByRole(document.body, 'button', { name: 'Sign out' })).toBeTruthy()
    })

    fireEvent.click(getByRole(document.body, 'button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:47387/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
    })
    await waitFor(() => {
      expect(reloadSpy).toHaveBeenCalledOnce()
    })
  })
})
