/* Minimal sandboxed guest input bridge adapted from T3 Code GuestProtocol/PickPreload at 9a0a0716 (MIT). */
import { ipcRenderer } from 'electron'
import { BROWSER_GUEST_AGENT_CURSOR_CHANNEL, BROWSER_GUEST_HUMAN_INPUT_CHANNEL, BROWSER_GUEST_SYNTHETIC_INPUT_CHANNEL } from './browser-bridge-contract.js'

let syntheticSequence: string | undefined
ipcRenderer.on(BROWSER_GUEST_SYNTHETIC_INPUT_CHANNEL, (_event, value: unknown) => {
  const sequence = value && typeof value === 'object' ? (value as { sequence?: unknown }).sequence : undefined
  syntheticSequence = typeof sequence === 'string' ? sequence : undefined
  if (syntheticSequence) ipcRenderer.send(BROWSER_GUEST_HUMAN_INPUT_CHANNEL, { kind: 'synthetic-ready', sequence: syntheticSequence })
})

ipcRenderer.on(BROWSER_GUEST_AGENT_CURSOR_CHANNEL, (_event, value: unknown) => {
  if (!value || typeof value !== 'object') return
  const cursor = value as { x?: unknown; y?: unknown; phase?: unknown }
  if (typeof cursor.x !== 'number' || typeof cursor.y !== 'number') return
  let host = document.querySelector('[data-forge-managed-browser-cursor]') as HTMLElement | null
  if (!host) {
    host = document.createElement('div')
    host.dataset.forgeManagedBrowserCursor = ''
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647'
    const shadow = host.attachShadow({ mode: 'closed' })
    const dot = document.createElement('div')
    dot.setAttribute('part', 'cursor')
    dot.style.cssText = 'width:14px;height:14px;border-radius:999px;border:2px solid #7c3aed;background:rgba(124,58,237,.22);transform:translate(-50%,-50%);transition:transform 80ms ease'
    shadow.append(dot)
    ;(host as HTMLElement & { __forgeCursorDot?: HTMLElement }).__forgeCursorDot = dot
    document.documentElement.append(host)
  }
  host.style.transform = `translate(${cursor.x}px,${cursor.y}px)`
  const dot = (host as HTMLElement & { __forgeCursorDot?: HTMLElement }).__forgeCursorDot
  if (dot) dot.style.transform = cursor.phase === 'click' ? 'translate(-50%,-50%) scale(.72)' : 'translate(-50%,-50%)'
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
