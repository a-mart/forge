import { describe, expect, it } from 'vitest'
import { makeBrowserKeySequence } from '../browser-keyboard.js'

describe('browser keyboard packets', () => {
  it.each([
    ['letter', { key: 'a' }, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' }],
    ['shifted letter', { key: 'a', modifiers: ['Shift'] }, { key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'A', modifiers: 8 }],
    ['punctuation', { key: '?', modifiers: ['Shift'] }, { key: '?', code: 'Slash', windowsVirtualKeyCode: 191, text: '?' }],
    ['function key', { key: 'F12' }, { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, type: 'rawKeyDown' }],
    ['arrow', { key: 'ArrowLeft' }, { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, type: 'rawKeyDown' }],
    ['space', { key: 'Space' }, { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }],
  ] as const)('builds %s packets', (_label, input, expected) => {
    const sequence = makeBrowserKeySequence(input)
    expect(sequence.keyDown).toMatchObject({ type: expected.type ?? 'keyDown', ...expected })
    expect(sequence.keyUp).toMatchObject({ type: 'keyUp', key: expected.key, code: expected.code, windowsVirtualKeyCode: expected.windowsVirtualKeyCode })
    expect(sequence.signal).toEqual({ kind: 'key', key: expected.key, code: expected.code })
  })

  it('maps modifier masks and suppresses printable text for control chords', () => {
    const sequence = makeBrowserKeySequence({ key: 'c', modifiers: ['Control', 'Alt', 'Meta'] })
    expect(sequence.keyDown).toMatchObject({ type: 'rawKeyDown', modifiers: 7 })
    expect(sequence.keyDown).not.toHaveProperty('text')
  })

  it('emits macOS editing commands and keeps key-up symmetric', () => {
    const sequence = makeBrowserKeySequence({ key: 'a', modifiers: ['Meta'] }, true)
    expect(sequence.keyDown).toMatchObject({ type: 'rawKeyDown', commands: ['selectAll'], modifiers: 4 })
    expect(sequence.keyUp).toMatchObject({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 })
  })

  it('uses a safe unknown-key packet for multi-character input', () => {
    expect(makeBrowserKeySequence({ key: 'UnmappedKey' }).keyDown).toMatchObject({ type: 'rawKeyDown', key: 'UnmappedKey', code: 'UnmappedKey', windowsVirtualKeyCode: 0 })
  })
})
