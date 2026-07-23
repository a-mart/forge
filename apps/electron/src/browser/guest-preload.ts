/* Minimal sandboxed guest input bridge adapted from T3 Code GuestProtocol/PickPreload at 9a0a0716 (MIT). */
import { ipcRenderer } from 'electron'
import { BROWSER_GUEST_HUMAN_INPUT_CHANNEL, BROWSER_GUEST_SYNTHETIC_INPUT_CHANNEL } from './browser-bridge-contract.js'

let syntheticSequence: string | undefined
ipcRenderer.on(BROWSER_GUEST_SYNTHETIC_INPUT_CHANNEL, (_event, value: unknown) => {
  const sequence = value && typeof value === 'object' ? (value as { sequence?: unknown }).sequence : undefined
  syntheticSequence = typeof sequence === 'string' ? sequence : undefined
  if (syntheticSequence) ipcRenderer.send(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, { kind: 'synthetic-ready', sequence: syntheticSequence })
})

window.addEventListener('pointerdown', (event) => {
  ipcRenderer.send(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {
    kind: 'pointer',
    x: event.clientX,
    y: event.clientY,
    button: event.button,
    ...(syntheticSequence ? { syntheticSequence } : {}),
  })
}, { capture: true, passive: true })

window.addEventListener('keydown', (event) => {
  ipcRenderer.send(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {
    kind: 'key',
    key: event.key,
    code: event.code,
    ...(syntheticSequence ? { syntheticSequence } : {}),
  })
}, { capture: true, passive: true })
