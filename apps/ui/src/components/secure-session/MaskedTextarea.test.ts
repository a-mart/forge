/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaskedTextarea } from './MaskedTextarea'

let container: HTMLDivElement
let root: Root

function renderMaskedTextarea(initialValue = '', onValueChange = vi.fn()): HTMLTextAreaElement {
  function Harness() {
    const [value, setValue] = useState(initialValue)
    return createElement(MaskedTextarea, {
      'aria-label': 'Private value',
      value,
      onValueChange: (nextValue) => {
        onValueChange(nextValue)
        setValue(nextValue)
      },
    })
  }

  flushSync(() => {
    root.render(createElement(Harness))
  })
  return container.querySelector('textarea')!
}

function paste(control: HTMLTextAreaElement, value: string): void {
  fireEvent.paste(control, {
    clipboardData: {
      getData: (format: string) => format === 'text/plain' ? value : '',
    },
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

describe('MaskedTextarea', () => {
  it('keeps CRLF paste bytes in state while exposing only masks and newlines', () => {
    const onValueChange = vi.fn()
    const control = renderMaskedTextarea('', onValueChange)
    const value = 'first\r\nAX-CANARY-DO-NOT-EXPOSE\r\nlast'

    flushSync(() => paste(control, value))

    expect(onValueChange).toHaveBeenLastCalledWith(value)
    expect(control.value).toBe('•••••\n•••••••••••••••••••••••\n••••')
    expect(control.value).not.toContain('AX-CANARY-DO-NOT-EXPOSE')
    expect(control.getAttribute('aria-label')).toBe('Private value')
  })

  it('keeps Unicode character boundaries intact while editing masked offsets', () => {
    const onValueChange = vi.fn()
    const control = renderMaskedTextarea('a💡b', onValueChange)

    expect(control.value).toBe('•••')
    control.setSelectionRange(1, 1)
    flushSync(() => fireEvent.keyDown(control, { key: 'X' }))
    expect(onValueChange).toHaveBeenLastCalledWith('aX💡b')
    expect(control.value).toBe('••••')

    control.setSelectionRange(2, 2)
    flushSync(() => fireEvent.keyDown(control, { key: 'Delete' }))
    expect(onValueChange).toHaveBeenLastCalledWith('aXb')
    expect(control.value).toBe('•••')
  })

  it('translates typing, selections, deletion, and CRLF paste offsets to raw bytes', () => {
    const onValueChange = vi.fn()
    const control = renderMaskedTextarea('ab\r\ncd', onValueChange)

    control.setSelectionRange(2, 2)
    flushSync(() => fireEvent.keyDown(control, { key: 'X' }))
    expect(onValueChange).toHaveBeenLastCalledWith('abX\r\ncd')
    expect(control.value).toBe('•••\n••')

    control.setSelectionRange(2, 3)
    flushSync(() => fireEvent.keyDown(control, { key: 'Backspace' }))
    expect(onValueChange).toHaveBeenLastCalledWith('ab\r\ncd')
    expect(control.value).toBe('••\n••')

    control.setSelectionRange(1, 3)
    flushSync(() => fireEvent.keyDown(control, { key: 'Q' }))
    expect(onValueChange).toHaveBeenLastCalledWith('aQcd')
    expect(control.value).toBe('••••')

    control.setSelectionRange(1, 1)
    flushSync(() => paste(control, '\r\nZ'))
    expect(onValueChange).toHaveBeenLastCalledWith('a\r\nZQcd')
    expect(control.value).toBe('•\n••••')
  })
})
