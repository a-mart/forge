import { loadVerifiedPayloadSelector } from './selector.js'

declare const FORGE_PAYLOAD_DIRECTORY: string
declare const FORGE_SERVICE_WORKER_SHA256: string

type Listener = (...args: unknown[]) => unknown

interface ChromeEvent {
  addListener(listener: Listener): void
}

interface ShellChrome {
  runtime: {
    getURL(path: string): string
    onInstalled: ChromeEvent
    onStartup: ChromeEvent
    onMessage: ChromeEvent
    onConnect: ChromeEvent
  }
  alarms: { onAlarm: ChromeEvent }
  debugger: { onEvent: ChromeEvent; onDetach: ChromeEvent }
  tabs: { onRemoved: ChromeEvent }
  webNavigation: { onCommitted: ChromeEvent; onDOMContentLoaded: ChromeEvent; onCompleted: ChromeEvent }
}

export type ShellEventName =
  | 'runtime.installed' | 'runtime.startup' | 'runtime.message' | 'runtime.connect'
  | 'alarm' | 'debugger.event' | 'debugger.detach' | 'tab.removed'
  | 'navigation.committed' | 'navigation.domContentLoaded' | 'navigation.completed'

export interface ServiceWorkerPayload {
  onShellEvent(name: ShellEventName, args: unknown[]): unknown
  shutdown?(): Promise<void> | void
}

export interface VerifiedPayloadIdentity {
  directory: string
  sha256: string
}

interface BundledServiceWorkerPayload {
  activateServiceWorker?: (identity: VerifiedPayloadIdentity) => Promise<ServiceWorkerPayload> | ServiceWorkerPayload
}

// The build wraps the exact service-worker payload bundle in this deferred,
// statically parsed factory. Chromium never has to add a script after install,
// and payload module initialization cannot run until selector verification passes.
declare function loadBundledServiceWorkerPayload(): BundledServiceWorkerPayload

const chromeApi = (globalThis as unknown as { chrome: ShellChrome }).chrome
let payload: ServiceWorkerPayload | null = null
const queuedEvents: Array<{ name: ShellEventName; args: unknown[] }> = []

function dispatch(name: ShellEventName, args: unknown[]): unknown {
  if (payload === null) {
    if (queuedEvents.length < 128) queuedEvents.push({ name, args })
    return name === 'runtime.message' ? true : undefined
  }
  return payload.onShellEvent(name, args)
}

function register(event: ChromeEvent, name: ShellEventName): void {
  event.addListener((...args: unknown[]) => dispatch(name, args))
}

// MV3 listeners are intentionally registered synchronously before selector I/O.
register(chromeApi.runtime.onInstalled, 'runtime.installed')
register(chromeApi.runtime.onStartup, 'runtime.startup')
register(chromeApi.runtime.onMessage, 'runtime.message')
register(chromeApi.runtime.onConnect, 'runtime.connect')
register(chromeApi.alarms.onAlarm, 'alarm')
register(chromeApi.debugger.onEvent, 'debugger.event')
register(chromeApi.debugger.onDetach, 'debugger.detach')
register(chromeApi.tabs.onRemoved, 'tab.removed')
register(chromeApi.webNavigation.onCommitted, 'navigation.committed')
register(chromeApi.webNavigation.onDOMContentLoaded, 'navigation.domContentLoaded')
register(chromeApi.webNavigation.onCompleted, 'navigation.completed')

async function boot(): Promise<void> {
  const selector = await loadVerifiedPayloadSelector((path) => chromeApi.runtime.getURL(path), 'service-worker.js')
  if (selector.payloadDirectory !== FORGE_PAYLOAD_DIRECTORY || selector.payloadFiles['service-worker.js'] !== FORGE_SERVICE_WORKER_SHA256) {
    throw new Error('selected payload does not match the installed shell')
  }
  const loaded = loadBundledServiceWorkerPayload()
  if (typeof loaded.activateServiceWorker !== 'function') throw new Error('selected payload has no service-worker activation export')
  payload = await loaded.activateServiceWorker({ directory: selector.payloadDirectory, sha256: selector.payloadSha256 })
  for (const event of queuedEvents.splice(0)) payload.onShellEvent(event.name, event.args)
  Object.defineProperty(globalThis, '__forgeServiceWorkerBootState', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ state: 'ready', directory: selector.payloadDirectory, sha256: selector.payloadSha256 }),
    writable: false,
  })
}

void boot().catch((error: unknown) => {
  console.error('Forge payload failed to boot', (error instanceof Error ? error.message : 'unknown error').slice(0, 256))
})
