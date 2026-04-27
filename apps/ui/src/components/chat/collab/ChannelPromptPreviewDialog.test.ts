/** @vitest-environment jsdom */

import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const apiMocks = vi.hoisted(() => ({
  fetchChannelPromptPreview: vi.fn(),
}))

vi.mock('@/lib/collaboration-api', () => ({
  fetchChannelPromptPreview: apiMocks.fetchChannelPromptPreview,
}))

const { ChannelPromptPreviewDialog } = await import('./ChannelPromptPreviewDialog')

let root: Root
let container: HTMLDivElement

function renderDialog(open = true) {
  flushSync(() => {
    root.render(
      createElement(ChannelPromptPreviewDialog, {
        open,
        onOpenChange: vi.fn(),
        channelId: 'channel-1',
        channelName: 'general',
      }),
    )
  })
}

function clickTextButton(label: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find((element) => element.textContent?.includes(label)) as HTMLButtonElement | undefined
  expect(button).toBeTruthy()
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.fetchChannelPromptPreview.mockReset()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

describe('ChannelPromptPreviewDialog', () => {
  it('loads and renders the combined prompt preview with the redaction note', async () => {
    apiMocks.fetchChannelPromptPreview.mockResolvedValue({
      channelId: 'channel-1',
      sections: [
        { label: 'System Prompt', content: 'Prompt body' },
        { label: 'Memory Composite', content: 'Memory body' },
      ],
      redacted: true,
    })

    renderDialog(true)

    await act(async () => {
      await Promise.resolve()
    })

    expect(apiMocks.fetchChannelPromptPreview).toHaveBeenCalledWith('channel-1')
    expect(document.body.textContent).toContain('Read-only runtime prompt preview for collaboration members. Absolute Forge paths are redacted.')
    expect(document.body.textContent).toContain('## System Prompt')
    expect(document.body.textContent).toContain('Prompt body')
    expect(document.body.textContent).toContain('## Memory Composite')
    expect(document.body.textContent).toContain('Memory body')
  })

  it('shows errors, retries, and can switch to section cards', async () => {
    apiMocks.fetchChannelPromptPreview
      .mockRejectedValueOnce(new Error('403: Authentication required'))
      .mockResolvedValueOnce({
        channelId: 'channel-1',
        sections: [
          { label: 'System Prompt', content: 'Prompt body' },
        ],
        redacted: true,
      })

    renderDialog(true)

    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('403: Authentication required')

    await act(async () => {
      clickTextButton('Retry')
      await Promise.resolve()
    })

    await act(async () => {
      clickTextButton('Sections')
      await Promise.resolve()
    })

    expect(apiMocks.fetchChannelPromptPreview).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('System Prompt')
    expect(document.body.textContent).toContain('Prompt body')
    expect(document.body.textContent).not.toContain('403: Authentication required')
  })
})
