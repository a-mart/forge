/** @vitest-environment jsdom */

import { getByRole, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileDeleteConfirmDialog } from './FileDeleteConfirmDialog'

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
})

function renderDialog(props: Partial<Parameters<typeof FileDeleteConfirmDialog>[0]> = {}) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(FileDeleteConfirmDialog, {
      open: true,
      entryName: 'App.tsx',
      entryType: 'file',
      onConfirm: vi.fn(),
      onClose: vi.fn(),
      ...props,
    }))
  })
}

describe('FileDeleteConfirmDialog', () => {
  it('shows an inline actionable delete failure without closing the dialog', () => {
    renderDialog({ errorMessage: 'HTTP 404: Route not found' })

    expect(getByRole(document.body, 'alert', { hidden: true }).textContent).toContain('HTTP 404: Route not found')
    expect(getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true })).toBeTruthy()
    expect(getByRole(document.body, 'button', { name: 'Cancel', hidden: true })).toBeTruthy()
  })

  it('disables actions while delete is in progress', () => {
    renderDialog({ isDeleting: true })

    expect((getByRole(document.body, 'button', { name: 'Deleting…', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
    expect((getByRole(document.body, 'button', { name: 'Cancel', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
    expect(queryByRole(document.body, 'alert', { hidden: true })).toBeNull()
  })
})
