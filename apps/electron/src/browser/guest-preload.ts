/* Minimal sandboxed guest input bridge adapted from T3 Code GuestProtocol/PickPreload at 9a0a0716 (MIT). */
import { ipcRenderer } from 'electron'
import { BROWSER_GUEST_HUMAN_INPUT_CHANNEL } from './browser-bridge-contract.js'

window.addEventListener('pointerdown', (event) => {
  ipcRenderer.send(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {
    kind: 'pointer',
    x: event.clientX,
    y: event.clientY,
    button: event.button,
  })
}, { capture: true, passive: true })

window.addEventListener('keydown', (event) => {
  ipcRenderer.send(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, {
    kind: 'key',
    key: event.key,
    code: event.code,
  })
}, { capture: true, passive: true })
