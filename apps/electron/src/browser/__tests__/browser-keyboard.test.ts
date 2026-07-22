import { describe, expect, it } from 'vitest'
import { makeBrowserKeySequence } from '../browser-keyboard.js'

describe('browser keyboard packets', () => {
  it('builds printable and named Chromium key packets', () => {
    const letter = makeBrowserKeySequence({ key: 'a', modifiers: ['Shift'] }, false)
    expect(letter.keyDown).toMatchObject({ type: 'keyDown', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 })
    expect(letter.keyUp).toMatchObject({ type: 'keyUp', key: 'A' })
    expect(makeBrowserKeySequence({ key: 'Enter' }, false).keyDown).toMatchObject({ windowsVirtualKeyCode: 13, text: '\r' })
  })

  it('adds macOS editing commands without printable chord text', () => {
    const sequence = makeBrowserKeySequence({ key: 'a', modifiers: ['Meta'] }, true)
    expect(sequence.keyDown).toMatchObject({ type: 'rawKeyDown', commands: ['selectAll'], modifiers: 4 })
  })
})
