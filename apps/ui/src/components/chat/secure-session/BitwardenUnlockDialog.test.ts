/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BitwardenUnlockDialog } from './BitwardenUnlockDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

describe('BitwardenUnlockDialog', () => {
  it('clears the password before awaiting the desktop unlock operation', async () => {
    let finishUnlock!: () => void
    const onUnlock = vi.fn(() => new Promise<void>((resolve) => {
      finishUnlock = resolve
    }))
    flushSync(() => {
      root.render(createElement(BitwardenUnlockDialog, {
        open: true,
        providerName: 'Bitwarden Password Manager',
        reason: 'secure_session',
        onUnlock,
        onDismiss: vi.fn(),
      }))
    })

    const password = getByLabelText(
      document.body,
      'Bitwarden master password',
    ) as HTMLInputElement
    fireEvent.change(password, { target: { value: 'synthetic-master-password' } })
    fireEvent.click(getByRole(document.body, 'button', { name: 'Unlock and start' }))

    await waitFor(() => {
      expect(password.value).toBe('')
      expect(onUnlock).toHaveBeenCalledWith('synthetic-master-password')
    })
    finishUnlock()
    await waitFor(() => {
      expect(getByRole(document.body, 'button', { name: 'Unlock and start' })).toBeTruthy()
    })
  })

  it('uses a dismissible launch prompt without submitting anything', () => {
    const onUnlock = vi.fn(async () => undefined)
    const onDismiss = vi.fn()
    flushSync(() => {
      root.render(createElement(BitwardenUnlockDialog, {
        open: true,
        providerName: 'Bitwarden Password Manager',
        reason: 'launch',
        onUnlock,
        onDismiss,
      }))
    })

    expect(document.body.textContent).toContain('is configured for Forge and needs to be unlocked')
    fireEvent.click(getByRole(document.body, 'button', { name: 'Not now' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onUnlock).not.toHaveBeenCalled()
  })
})
