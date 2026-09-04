/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

const originalClipboardDescriptor =
  Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard')
  ?? Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = document.execCommand

afterEach(() => {
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

function stubExecCommand(result: boolean) {
  const execCommand = vi.fn().mockReturnValue(result)
  document.execCommand = execCommand
  return execCommand
}

describe('copyTextToClipboard', () => {
  it('writes via the clipboard API when writeText is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const execCommand = stubExecCommand(true)

    await expect(copyTextToClipboard('hello from chat')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('hello from chat')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const execCommand = stubExecCommand(true)

    await expect(copyTextToClipboard('boneyard.rapaxray.io/*')).resolves.toBe(true)

    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back to execCommand when clipboard writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const execCommand = stubExecCommand(true)

    await expect(copyTextToClipboard('fallback text')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('fallback text')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('returns false when both clipboard API and execCommand fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    stubExecCommand(false)

    await expect(copyTextToClipboard('nope')).resolves.toBe(false)
  })
})
