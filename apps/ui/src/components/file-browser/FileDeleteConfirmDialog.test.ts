/** @vitest-environment jsdom */

import { getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileDeleteConfirmDialog } from './FileDeleteConfirmDialog'

let container: HTMLDivElement
let root: Root | null = null
const onConfirm = vi.fn()
const onClose = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  onConfirm.mockReset()
  onClose.mockReset()
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
      onConfirm,
      onClose,
      ...props,
    }))
  })
}

describe('FileDeleteConfirmDialog', () => {
  it('shows permanent delete copy for files and folders', () => {
    renderDialog()
    expect(document.body.textContent).toContain('Delete file')
    expect(document.body.textContent).toContain('permanently removes the file')

    renderDialog({ entryType: 'directory', entryName: 'src' })
    expect(document.body.textContent).toContain('Delete folder')
    expect(document.body.textContent).toContain('folder and its contents')
  })

  it('calls confirm and close handlers from actions', () => {
    renderDialog()

    const deleteButton = getByRole(document.body, 'button', { name: 'Delete permanently', hidden: true })
    const cancelButton = getByRole(document.body, 'button', { name: 'Cancel', hidden: true })

    flushSync(() => deleteButton.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)

    flushSync(() => cancelButton.click())
    expect(onClose).toHaveBeenCalled()
  })
})
