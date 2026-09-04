/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MarkdownMessage } from './MarkdownMessage'

let root: Root
let container: HTMLDivElement
const originalClipboardDescriptor =
  Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard')
  ?? Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = document.execCommand

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()

  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  } else {
    delete (navigator as Partial<Record<'clipboard', Clipboard>>).clipboard
  }

  if (originalExecCommand) {
    document.execCommand = originalExecCommand
  } else {
    delete (document as Partial<Pick<Document, 'execCommand'>>).execCommand
  }
})

describe('MarkdownMessage copy button', () => {
  it('copies fenced code through execCommand when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand
    const content = ['```text', 'boneyard.rapaxray.io/*', '```'].join('\n')

    act(() => {
      root.render(createElement(TooltipProvider, null, createElement(MarkdownMessage, { content })))
    })

    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')
    expect(copyButton).not.toBeNull()

    await act(async () => {
      copyButton!.click()
      await Promise.resolve()
    })

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(copyButton!.getAttribute('aria-label')).toBe('Copied')
  })
})
