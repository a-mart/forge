/* Keyboard packet construction is adapted from T3 Code PreviewKeyboard.ts at 9a0a0716 (MIT). */
import type { BrowserPressInput } from '@forge/protocol'

type Modifier = NonNullable<BrowserPressInput['modifiers']>[number]
type KeyDefinition = { code: string; key: string; keyCode: number; text?: string; location?: number; shiftedKey?: string }
export type BrowserKeyEvent = Record<string, unknown> & {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  modifiers: number
  windowsVirtualKeyCode: number
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Escape: { code: 'Escape', key: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', key: 'Tab', keyCode: 9 }, Enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  Shift: { code: 'ShiftLeft', key: 'Shift', keyCode: 16, location: 1 }, Control: { code: 'ControlLeft', key: 'Control', keyCode: 17, location: 1 },
  Alt: { code: 'AltLeft', key: 'Alt', keyCode: 18, location: 1 }, Meta: { code: 'MetaLeft', key: 'Meta', keyCode: 91, location: 1 },
  CapsLock: { code: 'CapsLock', key: 'CapsLock', keyCode: 20 }, Space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
  PageUp: { code: 'PageUp', key: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  End: { code: 'End', key: 'End', keyCode: 35 }, Home: { code: 'Home', key: 'Home', keyCode: 36 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 }, ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 }, ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  Insert: { code: 'Insert', key: 'Insert', keyCode: 45 }, Delete: { code: 'Delete', key: 'Delete', keyCode: 46 },
}
const PRINTABLE: KeyDefinition[] = [
  ['Backquote', '`', '~', 192], ['Digit1', '1', '!', 49], ['Digit2', '2', '@', 50], ['Digit3', '3', '#', 51],
  ['Digit4', '4', '$', 52], ['Digit5', '5', '%', 53], ['Digit6', '6', '^', 54], ['Digit7', '7', '&', 55],
  ['Digit8', '8', '*', 56], ['Digit9', '9', '(', 57], ['Digit0', '0', ')', 48], ['Minus', '-', '_', 189],
  ['Equal', '=', '+', 187], ['Backslash', '\\', '|', 220], ['BracketLeft', '[', '{', 219], ['BracketRight', ']', '}', 221],
  ['Semicolon', ';', ':', 186], ['Quote', "'", '"', 222], ['Comma', ',', '<', 188], ['Period', '.', '>', 190], ['Slash', '/', '?', 191],
].map(([code, key, shiftedKey, keyCode]) => ({ code: String(code), key: String(key), shiftedKey: String(shiftedKey), keyCode: Number(keyCode) }))

const MAC_COMMANDS: Record<string, string> = {
  'Meta+Backspace': 'deleteToBeginningOfLine', 'Meta+ArrowUp': 'moveToBeginningOfDocument', 'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine', 'Meta+ArrowRight': 'moveToRightEndOfLine', 'Meta+KeyA': 'selectAll',
  'Meta+KeyC': 'copy', 'Meta+KeyX': 'cut', 'Meta+KeyV': 'paste', 'Meta+KeyZ': 'undo', 'Shift+Meta+KeyZ': 'redo',
}
const ORDER: Modifier[] = ['Shift', 'Control', 'Alt', 'Meta']

function modifierMask(modifiers: BrowserPressInput['modifiers']): number {
  return (modifiers ?? []).reduce((mask, modifier) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier]), 0)
}
function definition(input: BrowserPressInput): KeyDefinition {
  if (NAMED_KEYS[input.key]) return NAMED_KEYS[input.key]!
  const fn = /^F([1-9]|1[0-2])$/.exec(input.key)
  if (fn) return { code: input.key, key: input.key, keyCode: 111 + Number(fn[1]) }
  if (/^[a-z]$/i.test(input.key)) {
    const upper = input.key.toUpperCase()
    const key = input.modifiers?.includes('Shift') || input.key === upper ? upper : input.key
    return { code: `Key${upper}`, key, keyCode: upper.charCodeAt(0), text: key }
  }
  const printable = PRINTABLE.find((item) => item.key === input.key || item.shiftedKey === input.key)
  if (printable) {
    const key = printable.shiftedKey && (input.modifiers?.includes('Shift') || input.key === printable.shiftedKey) ? printable.shiftedKey : printable.key
    return { ...printable, key, text: key }
  }
  return { code: input.key.length > 1 ? input.key : '', key: input.key, keyCode: 0, ...(input.key.length === 1 ? { text: input.key } : {}) }
}

export function makeBrowserKeySequence(input: BrowserPressInput, isMac = process.platform === 'darwin'): {
  keyDown: BrowserKeyEvent
  keyUp: BrowserKeyEvent
  signal: { kind: 'key'; key: string; code: string }
} {
  const resolved = definition(input)
  const modifiers = modifierMask(input.modifiers)
  const text = input.modifiers?.some((modifier) => modifier !== 'Shift') ? '' : (resolved.text ?? '')
  const shared = { key: resolved.key, code: resolved.code, modifiers, windowsVirtualKeyCode: resolved.keyCode, location: resolved.location ?? 0, isKeypad: resolved.location === 3 }
  const shortcut = [...ORDER.filter((modifier) => input.modifiers?.includes(modifier)), resolved.code].join('+')
  const command = isMac ? MAC_COMMANDS[shortcut] : undefined
  return {
    keyDown: { type: text ? 'keyDown' : 'rawKeyDown', ...shared, ...(text ? { text, unmodifiedText: text } : {}), ...(command ? { commands: [command] } : {}) },
    keyUp: { type: 'keyUp', ...shared },
    signal: { kind: 'key', key: resolved.key, code: resolved.code },
  }
}
