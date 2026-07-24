import type { ChromeApi, ChromeDebuggerSession, ChromeRuntimePort, ChromeStorageArea, ChromeTab, ChromeTabGroup, ChromeWindow } from '../src/runtime/chrome-api.js'

export class FakeStorage implements ChromeStorageArea {
  readonly values: Record<string, unknown> = {}
  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (keys === undefined || keys === null) return structuredClone(this.values)
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
    return Object.fromEntries(names.filter((key) => key in this.values).map((key) => [key, structuredClone(this.values[key])]))
  }
  async set(items: Record<string, unknown>): Promise<void> { Object.assign(this.values, structuredClone(items)) }
  async remove(keys: string | string[]): Promise<void> { for (const key of typeof keys === 'string' ? [keys] : keys) delete this.values[key] }
}

export interface FakeChromeOptions {
  tabs?: ChromeTab[]
  groups?: ChromeTabGroup[]
  windows?: ChromeWindow[]
  session?: FakeStorage
  detachFailures?: Set<number>
}

export function fakeChrome(options: FakeChromeOptions = {}): ChromeApi & { attached: Set<number>; commands: Array<{ target: ChromeDebuggerSession; method: string; params?: Record<string, unknown> }> } {
  const tabs = options.tabs ?? []
  const groups = options.groups ?? []
  const session = options.session ?? new FakeStorage()
  const local = new FakeStorage()
  const attached = new Set<number>()
  const commands: Array<{ target: ChromeDebuggerSession; method: string; params?: Record<string, unknown> }> = []
  let nextTabId = Math.max(0, ...tabs.map((tab) => tab.id ?? 0)) + 1
  let nextGroupId = Math.max(0, ...groups.map((group) => group.id)) + 1
  return {
    attached,
    commands,
    runtime: {
      id: 'fcchfcnadajoejfbiclihglkmbcfhajd',
      getURL: (value) => `chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/${value}`,
      getPlatformInfo: async () => ({ os: 'mac', arch: 'arm' }),
      connectNative: () => { throw new Error('not configured') },
      connect: () => { throw new Error('not configured') },
      sendMessage: async () => ({}),
      reload: () => undefined,
    },
    tabs: {
      query: async () => structuredClone(tabs),
      get: async (tabId) => {
        const tab = tabs.find((entry) => entry.id === tabId)
        if (tab === undefined) throw new Error('missing tab')
        return structuredClone(tab)
      },
      create: async (properties) => {
        const tab = { id: nextTabId++, windowId: 1, groupId: -1, active: properties.active, url: properties.url ?? 'about:blank', title: 'Created' }
        tabs.push(tab)
        return structuredClone(tab)
      },
      group: async ({ tabIds, groupId }) => {
        const selectedGroup = groupId ?? nextGroupId++
        for (const tab of tabs) if (tab.id !== undefined && tabIds.includes(tab.id)) tab.groupId = selectedGroup
        if (!groups.some((group) => group.id === selectedGroup)) groups.push({ id: selectedGroup, windowId: 1, title: '', collapsed: false })
        return selectedGroup
      },
    },
    tabGroups: {
      query: async () => structuredClone(groups),
      update: async (groupId, properties) => {
        const group = groups.find((entry) => entry.id === groupId)
        if (group === undefined) throw new Error('missing group')
        Object.assign(group, properties)
        return structuredClone(group)
      },
    },
    windows: {
      getAll: async () => structuredClone(options.windows ?? [{ id: 1, focused: true, tabs }]),
    },
    storage: { local, session },
    scripting: { executeScript: async () => [] },
    debugger: {
      attach: async (target) => {
        if (target.tabId === undefined || attached.has(target.tabId)) throw new Error('Another debugger is already attached')
        attached.add(target.tabId)
      },
      detach: async (target) => {
        if (target.tabId !== undefined && options.detachFailures?.has(target.tabId) === true) throw new Error('already detached')
        if (target.tabId !== undefined) attached.delete(target.tabId)
      },
      sendCommand: async (target, method, params) => {
        commands.push({ target, method, ...(params === undefined ? {} : { params }) })
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: `target-tab-${String(target.tabId)}`, type: 'page', attached: true } }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-tab-${String(target.tabId)}` } } }
        return {}
      },
    },
    sidePanel: { open: async () => undefined, setPanelBehavior: async () => undefined },
    alarms: { create: () => undefined, clear: async () => true },
  }
}

export class FakePort implements ChromeRuntimePort {
  readonly name = 'native'
  readonly sent: unknown[] = []
  disconnected = false
  private messageListener: ((message: unknown) => void) | null = null
  private disconnectListener: (() => void) | null = null
  onPost?: (message: unknown) => void
  onMessage = { addListener: (listener: (message: unknown) => void) => { this.messageListener = listener } }
  onDisconnect = { addListener: (listener: () => void) => { this.disconnectListener = listener } }
  postMessage(message: unknown): void { this.sent.push(message); this.onPost?.(message) }
  disconnect(): void { this.disconnected = true }
  emitMessage(message: unknown): void { this.messageListener?.(message) }
  emitDisconnect(): void { this.disconnectListener?.() }
}
