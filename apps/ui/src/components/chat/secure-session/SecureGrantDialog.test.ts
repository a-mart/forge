/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByLabelText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecureGrantDialog } from './SecureGrantDialog'

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
  vi.restoreAllMocks()
})

describe('SecureGrantDialog', () => {
  it('shows a bounded recovery action instead of scope and Grant 0 for an empty vault', () => {
    const onAddSecret = vi.fn()
    const onClose = vi.fn()
    flushSync(() => {
      root.render(createElement(SecureGrantDialog, {
        secrets: [],
        onGrant: vi.fn(),
        onAddSecret,
        onClose,
      }))
    })

    expect(document.body.textContent).toContain(
      'No saved project secrets are configured yet.',
    )
    expect(queryByLabelText(document.body, 'Scope')).toBeNull()
    expect(document.body.textContent).not.toContain('Grant 0 secrets')

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', {
        name: 'Add a project secret',
      }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onAddSecret).toHaveBeenCalledTimes(1)
  })

  it('routes configured but unavailable secrets to management without grant controls', () => {
    const onAddSecret = vi.fn()
    flushSync(() => {
      root.render(createElement(SecureGrantDialog, {
        secrets: [{
          secretId: 'secret-1',
          displayAlias: 'deploy-token',
          available: false,
          bindings: [{ kind: 'env', variable: 'DEPLOY_TOKEN' }],
        }],
        onGrant: vi.fn(),
        onAddSecret,
        onClose: vi.fn(),
      }))
    })

    expect(document.body.textContent).toContain(
      'Saved secrets are configured, but none are currently available to grant.',
    )
    expect(queryByLabelText(document.body, 'Scope')).toBeNull()
    expect(getByRole(document.body, 'button', {
      name: 'Manage project secrets',
    })).toBeTruthy()
  })
})
