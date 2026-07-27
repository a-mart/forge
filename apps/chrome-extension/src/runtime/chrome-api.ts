export interface ChromeTab {
  id?: number
  windowId?: number
  active?: boolean
  title?: string
  url?: string
}

export interface ChromeWindow {
  id?: number
  focused: boolean
  tabs?: ChromeTab[]
}

export interface ChromeStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface ChromeDebuggerTarget {
  tabId?: number
  targetId?: string
  extensionId?: string
  attached?: boolean
}

export interface ChromeDebuggerSession extends ChromeDebuggerTarget {
  sessionId?: string
}

export interface ChromeDebuggerApi {
  getTargets(): Promise<ChromeDebuggerTarget[]>
  attach(target: ChromeDebuggerTarget, requiredVersion: string): Promise<void>
  detach(target: ChromeDebuggerTarget): Promise<void>
  sendCommand(target: ChromeDebuggerSession, method: string, commandParams?: Record<string, unknown>): Promise<unknown>
}

export interface ChromeRuntimePort {
  name: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

export interface ChromeRuntimeSender {
  tab?: ChromeTab
  frameId?: number
}

export interface ChromeApi {
  runtime: {
    id: string
    lastError?: { message?: string }
    getURL(path: string): string
    getPlatformInfo(): Promise<{ os: string; arch: string }>
    connectNative(application: string): ChromeRuntimePort
    connect(options: { name: string }): ChromeRuntimePort
    sendMessage(message: unknown): Promise<unknown>
    reload(): void
  }
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>
    get(tabId: number): Promise<ChromeTab>
    create(createProperties: { url?: string; active?: boolean }): Promise<ChromeTab>
    remove(tabIds: number | number[]): Promise<void>
  }
  windows: {
    getAll(getInfo?: Record<string, unknown>): Promise<ChromeWindow[]>
  }
  storage: {
    local: ChromeStorageArea
    session: ChromeStorageArea
  }
  scripting: {
    executeScript(injection: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[] }
      files: string[]
      world?: 'ISOLATED' | 'MAIN'
    }): Promise<unknown[]>
  }
  debugger: ChromeDebuggerApi
  alarms: {
    create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): void
    clear(name: string): Promise<boolean>
  }
}

export function installedChrome(): ChromeApi {
  return (globalThis as unknown as { chrome: ChromeApi }).chrome
}
