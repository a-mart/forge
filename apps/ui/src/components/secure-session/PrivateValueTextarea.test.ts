/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrivateValueTextarea } from './PrivateValueTextarea'

let container: HTMLDivElement
let root: Root

function renderPrivateValueTextarea(
  initialValue = '',
  onValueChange = vi.fn(),
): HTMLTextAreaElement {
  function Harness() {
    const [value, setValue] = useState(initialValue)
    return createElement(PrivateValueTextarea, {
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

describe('PrivateValueTextarea', () => {
  it('shows the current value while preserving pasted CRLF bytes in state', () => {
    const onValueChange = vi.fn()
    const control = renderPrivateValueTextarea('', onValueChange)
    const value = 'first\r\nvisible-private-value\r\nlast'

    flushSync(() => paste(control, value))

    expect(onValueChange).toHaveBeenLastCalledWith(value)
    expect(control.value).toBe('first\nvisible-private-value\nlast')
    expect(control.className).not.toContain('text-security')
    expect(control.getAttribute('aria-label')).toBe('Private value')
  })

  it('preserves raw line endings when editing visible text', () => {
    const onValueChange = vi.fn()
    const control = renderPrivateValueTextarea('ab\r\ncd', onValueChange)

    flushSync(() => {
      fireEvent.change(control, { target: { value: 'abX\ncd' } })
    })

    expect(onValueChange).toHaveBeenLastCalledWith('abX\r\ncd')
    expect(control.value).toBe('abX\ncd')
  })
})
