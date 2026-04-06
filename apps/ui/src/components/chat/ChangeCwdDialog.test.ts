/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeCwdDialog } from './ChangeCwdDialog'
import type { DirectoryValidationResult } from '@/lib/ws-client'

function changeValue(element: HTMLInputElement, value: string): void {
  flushSync(() => {
    fireEvent.change(element, {
      target: { value },
    })
  })
}

describe('ChangeCwdDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => {
      root.unmount()
    })
    container.remove()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  function renderDialog(options?: {
    currentCwd?: string
    onConfirm?: (profileId: string, cwd: string) => Promise<void>
    onValidateDirectory?: (path: string) => Promise<DirectoryValidationResult>
  }) {
    const onConfirm = options?.onConfirm ?? vi.fn().mockResolvedValue(undefined)
    const onValidateDirectory =
      options?.onValidateDirectory ??
      vi.fn().mockResolvedValue({
        path: '/repo/next',
        valid: true,
        message: null,
        resolvedPath: '/repo/next',
      })

    flushSync(() => {
      root.render(
        createElement(ChangeCwdDialog, {
          profileId: 'alpha',
          profileLabel: 'Alpha',
          currentCwd: options?.currentCwd ?? '/repo/current',
          onConfirm,
          onClose: vi.fn(),
          onBrowseDirectory: vi.fn().mockResolvedValue(null),
          onValidateDirectory,
        }),
      )
    })

    return { onConfirm, onValidateDirectory }
  }

  it('disables submit when validation resolves back to the current cwd', async () => {
    const onValidateDirectory = vi.fn().mockResolvedValue({
      path: './',
      valid: true,
      message: null,
      resolvedPath: '/repo/current',
    })

    renderDialog({ onValidateDirectory })

    const input = getByLabelText(document.body, 'Working directory') as HTMLInputElement
    changeValue(input, './')

    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(onValidateDirectory).toHaveBeenCalledWith('./'))

    const submitButton = getByRole(document.body, 'button', { name: 'Update' }) as HTMLButtonElement
    await waitFor(() => expect(submitButton.disabled).toBe(true))
  })

  it('discards stale validation responses after reverting to the current cwd', async () => {
    let resolveValidation: ((result: DirectoryValidationResult) => void) | undefined
    const onValidateDirectory = vi.fn(
      () =>
        new Promise<DirectoryValidationResult>((resolve) => {
          resolveValidation = resolve
        }),
    )

    renderDialog({ onValidateDirectory })

    const input = getByLabelText(document.body, 'Working directory') as HTMLInputElement
    changeValue(input, '/repo/next')

    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(onValidateDirectory).toHaveBeenCalledWith('/repo/next'))

    changeValue(input, '/repo/current')

    resolveValidation?.({
      path: '/repo/next',
      valid: false,
      message: 'Directory does not exist.',
      resolvedPath: '/repo/next',
    })
    await Promise.resolve()

    const submitButton = getByRole(document.body, 'button', { name: 'Update' }) as HTMLButtonElement
    await waitFor(() => expect(submitButton.disabled).toBe(true))
    expect(document.body.textContent).not.toContain('Directory does not exist.')
  })

  it('submits the resolved path from validation instead of the raw input', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onValidateDirectory = vi.fn().mockResolvedValue({
      path: '../alias',
      valid: true,
      message: null,
      resolvedPath: '/repo/other',
    })

    renderDialog({ onConfirm, onValidateDirectory })

    const input = getByLabelText(document.body, 'Working directory') as HTMLInputElement
    changeValue(input, '../alias')

    await vi.advanceTimersByTimeAsync(300)
    await waitFor(() => expect(onValidateDirectory).toHaveBeenCalledWith('../alias'))

    const submitButton = getByRole(document.body, 'button', { name: 'Update' }) as HTMLButtonElement
    await waitFor(() => expect(submitButton.disabled).toBe(false))

    flushSync(() => {
      submitButton.click()
    })

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('alpha', '/repo/other'))
  })
})
