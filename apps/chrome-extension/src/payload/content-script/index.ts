import { installedChrome } from '../../runtime/chrome-api.js'
import { isTrustedHumanInterruption } from '../../runtime/human-control.js'

const ROOT_ID = '__forge_external_chrome_status__'
const FAVICON_MARK = 'data-forge-external-status'
const chromeApi = installedChrome()
const nonce = crypto.randomUUID()
const port = chromeApi.runtime.connect({ name: `forge-leased-frame:${nonce}` })
let syntheticUntil = 0
let activeControlEpoch = 0
let activeOperationId: string | null = null
let controlState: 'human' | 'agent' | 'handoff' = 'human'

function pointer(): HTMLDivElement {
  let element = document.getElementById(ROOT_ID) as HTMLDivElement | null
  if (element !== null) return element
  element = document.createElement('div')
  element.id = ROOT_ID
  element.setAttribute('aria-hidden', 'true')
  Object.assign(element.style, {
    all: 'initial', position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', width: '18px', height: '18px',
    border: '2px solid #ffffff', borderRadius: '50%', boxShadow: '0 0 0 2px #5b5cf0', left: '8px', top: '8px',
    display: 'none', transition: 'left 60ms linear, top 60ms linear',
  })
  document.documentElement.append(element)
  return element
}

function statusSvg(state: typeof controlState): string {
  const color = state === 'agent' ? '#5b5cf0' : state === 'handoff' ? '#f0a64b' : '#48b77b'
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><path fill="white" d="M9 7h15v5H14v3h8v5h-8v6H9z"/></svg>`)}`
}

function markFavicon(state: typeof controlState): void {
  if (window.top !== window) return
  let icon = document.head.querySelector<HTMLLinkElement>(`link[${FAVICON_MARK}]`)
  if (icon === null) {
    icon = document.createElement('link')
    icon.rel = 'icon'
    icon.setAttribute(FAVICON_MARK, 'true')
    document.head.append(icon)
  }
  icon.href = statusSvg(state)
}

function setState(state: typeof controlState): void {
  controlState = state
  markFavicon(state)
  const element = pointer()
  element.style.boxShadow = `0 0 0 2px ${state === 'agent' ? '#5b5cf0' : state === 'handoff' ? '#f0a64b' : '#48b77b'}`
  if (state !== 'agent') element.style.display = 'none'
}

function inputKind(event: Event): 'pointer' | 'key' | 'wheel' | 'touch' {
  if (event.type.startsWith('key')) return 'key'
  if (event.type.startsWith('wheel')) return 'wheel'
  if (event.type.startsWith('touch')) return 'touch'
  return 'pointer'
}

function trustedInput(event: Event): void {
  if (!isTrustedHumanInterruption({ isTrusted: event.isTrusted, observedAt: performance.now(), syntheticUntil })) return
  setState('human')
  port.postMessage({ type: 'trusted-human-input', nonce, controlEpoch: activeControlEpoch, event: inputKind(event), at: new Date().toISOString() })
}

for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
  globalThis.addEventListener(eventName, trustedInput, { capture: true, passive: true })
}

globalThis.addEventListener('pointermove', (event) => {
  if (controlState !== 'agent' || !(event instanceof PointerEvent)) return
  const element = pointer()
  element.style.display = 'block'
  element.style.left = `${Math.max(0, event.clientX - 9)}px`
  element.style.top = `${Math.max(0, event.clientY - 9)}px`
}, { capture: true, passive: true })

port.onMessage.addListener((message) => {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return
  const command = message as Record<string, unknown>
  if (command.nonce !== nonce) return
  if (command.type === 'synthetic-start' && typeof command.operationId === 'string' && Number.isSafeInteger(command.controlEpoch)) {
    syntheticUntil = performance.now() + Math.min(5_000, typeof command.durationMs === 'number' ? command.durationMs : 1_000)
    activeOperationId = command.operationId
    activeControlEpoch = command.controlEpoch as number
    setState('agent')
    port.postMessage({ type: 'synthetic-ack', nonce, operationId: activeOperationId, controlEpoch: activeControlEpoch })
  } else if (command.type === 'synthetic-end' && command.operationId === activeOperationId && command.controlEpoch === activeControlEpoch) {
    syntheticUntil = 0
    activeOperationId = null
  } else if (command.type === 'status' && (command.state === 'human' || command.state === 'agent' || command.state === 'handoff')) {
    setState(command.state)
  }
})

port.postMessage({ type: 'content-ready', nonce, hrefOrigin: location.origin })
setState('human')
