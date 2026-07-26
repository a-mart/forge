import { loadVerifiedPayloadSelector, payloadResourcePath } from './selector.js'

declare const FORGE_PAYLOAD_DIRECTORY: string
declare function importScripts(...urls: string[]): void

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
  action: { onClicked: ChromeEvent }
  alarms: { onAlarm: ChromeEvent }
  debugger: { onEvent: ChromeEvent; onDetach: ChromeEvent }
  tabs: { onRemoved: ChromeEvent; onCreated: ChromeEvent; onUpdated: ChromeEvent }
  webNavigation: { onCommitted: ChromeEvent }
  downloads: { onChanged: ChromeEvent }
}

export type ShellEventName =
  | 'runtime.installed' | 'runtime.startup' | 'runtime.message' | 'runtime.connect'
  | 'action.clicked' | 'alarm' | 'debugger.event' | 'debugger.detach'
  | 'tab.removed' | 'tab.created' | 'tab.updated' | 'navigation.committed' | 'download.changed'

export interface ServiceWorkerPayload {
  onShellEvent(name: ShellEventName, args: unknown[]): unknown
  shutdown?(): Promise<void> | void
}

export interface VerifiedPayloadIdentity {
  directory: string
  sha256: string
}

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

// MV3 listeners are intentionally registered synchronously before selector I/O/import.
register(chromeApi.runtime.onInstalled, 'runtime.installed')
register(chromeApi.runtime.onStartup, 'runtime.startup')
register(chromeApi.runtime.onMessage, 'runtime.message')
register(chromeApi.runtime.onConnect, 'runtime.connect')
register(chromeApi.action.onClicked, 'action.clicked')
register(chromeApi.alarms.onAlarm, 'alarm')
register(chromeApi.debugger.onEvent, 'debugger.event')
register(chromeApi.debugger.onDetach, 'debugger.detach')
register(chromeApi.tabs.onRemoved, 'tab.removed')
register(chromeApi.tabs.onCreated, 'tab.created')
register(chromeApi.tabs.onUpdated, 'tab.updated')
register(chromeApi.webNavigation.onCommitted, 'navigation.committed')
register(chromeApi.downloads.onChanged, 'download.changed')

async function boot(): Promise<void> {
  const selector = await loadVerifiedPayloadSelector((path) => chromeApi.runtime.getURL(path), 'service-worker.js')
  if (selector.payloadDirectory !== FORGE_PAYLOAD_DIRECTORY) throw new Error('selected payload does not match the installed shell')
  const payloadUrl = chromeApi.runtime.getURL(payloadResourcePath(selector, 'service-worker.js'))
  // Classic importScripts is intentionally delayed until all payload files have passed SHA-256 verification.
  importScripts(payloadUrl)
  const loaded = (globalThis as unknown as { ForgeExternalChromePayload?: {
    activateServiceWorker?: (identity: VerifiedPayloadIdentity) => Promise<ServiceWorkerPayload> | ServiceWorkerPayload
  } }).ForgeExternalChromePayload
  if (typeof loaded?.activateServiceWorker !== 'function') throw new Error('selected payload has no service-worker activation export')
  payload = await loaded.activateServiceWorker({ directory: selector.payloadDirectory, sha256: selector.payloadSha256 })
  for (const event of queuedEvents.splice(0)) payload.onShellEvent(event.name, event.args)
}

void boot().catch((error: unknown) => {
  console.error('Forge payload failed to boot', (error instanceof Error ? error.message : 'unknown error').slice(0, 256))
})
