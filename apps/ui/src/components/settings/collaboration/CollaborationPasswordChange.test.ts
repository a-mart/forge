/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const apiMock = vi.hoisted(() => ({
  changeMyPassword: vi.fn(),
}))

vi.mock('../collaboration-settings-api', () => ({
  changeMyPassword: (...args: unknown[]) => apiMock.changeMyPassword(...args),
}))

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let CollaborationPasswordChange: typeof import('./CollaborationPasswordChange').CollaborationPasswordChange

beforeEach(async () => {
  const mod = await import('./CollaborationPasswordChange')
  CollaborationPasswordChange = mod.CollaborationPasswordChange
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

function render(apiBaseUrl: string, onChanged?: () => void) {
  if (!root) root = createRoot(container)
  flushSync(() => {
    root!.render(createElement(CollaborationPasswordChange, { apiBaseUrl, onChanged }))
  })
}

function fillAndSubmit() {
  const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
  const inputs = form.querySelectorAll('input[type="password"]')
  // Simulate React onChange via setting value then dispatching input event
  const setInput = (el: HTMLInputElement, value: string) => {
    // Use native setter to trigger React synthetic onChange
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    nativeSetter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setInput(inputs[0] as HTMLInputElement, 'oldpass123')
  setInput(inputs[1] as HTMLInputElement, 'newpass123')
  setInput(inputs[2] as HTMLInputElement, 'newpass123')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('CollaborationPasswordChange — stale-request race protection', () => {
  it('late password change success from backend A does not set success or call onChanged on backend B', async () => {
    const onChanged = vi.fn()

    // Backend A: slow password change
    let resolveA: (() => void) | null = null
    const slowA = new Promise<void>((resolve) => { resolveA = resolve })
    apiMock.changeMyPassword.mockImplementationOnce(() => slowA)

    render('https://server-a.test/', onChanged)
    await flush()

    fillAndSubmit()
    await flush()

    // Switch to B before A resolves
    apiMock.changeMyPassword.mockResolvedValue(undefined)
    render('https://server-b.test/', onChanged)
    await flush()

    // Now resolve stale A
    resolveA!()
    await flush()
    await flush()

    // onChanged must NOT have been called (A's result is stale)
    expect(onChanged).not.toHaveBeenCalled()
    // Success banner must not appear
    expect(container.querySelector('[data-testid="password-success"]')).toBeNull()
  })

  it('late password change failure from backend A does not set error on backend B', async () => {
    // Backend A: slow password change that will fail
    let rejectA: ((err: Error) => void) | null = null
    const slowA = new Promise<void>((_resolve, reject) => { rejectA = reject })
    apiMock.changeMyPassword.mockImplementationOnce(() => slowA)

    render('https://server-a.test/')
    await flush()

    fillAndSubmit()
    await flush()

    // Switch to B before A resolves
    render('https://server-b.test/')
    await flush()

    // Now reject stale A
    rejectA!(new Error('Wrong password on A'))
    await flush()
    await flush()

    // Error banner must not appear on B
    expect(container.querySelector('[data-testid="password-error"]')).toBeNull()
  })
})
