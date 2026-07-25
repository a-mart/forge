/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalChromeBridge, ExternalChromeLocalStatus } from '@/lib/electron-bridge'
import { ExternalChromePanel } from './ExternalChromePanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root | null = null

const coordinator = {
  state: 'online' as const, authority: 'owned' as const, auth: 'secure' as const, registration: 'owned' as const,
  trust: 'trusted' as const, platform: 'darwin' as const, canEnable: false, canDisable: true, canRepair: true,
  canRollback: false, canRemove: true, canTakeover: false, canReveal: true, recovery: 'ready' as const,
  setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd' as const, pathState: 'ready' as const, loadUnpackedPath: '/private' },
}
const instances = [
  { extensionInstanceId: 'profile_a', profileAlias: 'Work', chromeVersion: '125', payloadVersion: '1', connectedAt: 'now' },
  { extensionInstanceId: 'profile_b', profileAlias: 'Personal', chromeVersion: '125', payloadVersion: '1', connectedAt: 'now' },
]
const baseStatus: ExternalChromeLocalStatus = { coordinator, instances, attachment: null }

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; container.remove(); delete window.electronBridge; vi.useRealTimers() })

function bridge(): ExternalChromeBridge {
  const control = vi.fn(async () => ({ ok: true as const, status: coordinator }))
  return {
    status: control, enable: control, disable: control, repair: control, rollback: control, remove: control, takeover: control, revealExtensionFolder: control,
    localStatus: vi.fn(async () => ({ ok: true as const, status: baseStatus })),
    listCandidates: vi.fn(async (_session, _profile, extensionInstanceId) => ({ ok: true as const, status: baseStatus, windows: [{ windowId: 1, focused: true, groups: [{ groupId: 9, title: 'Forge · session-1', collapsed: false }], tabs: [
      { windowId: 1, tabId: 7, groupId: 9, title: `${extensionInstanceId} private title`, origin: 'https://private.example', active: true, attached: false, restricted: false, debuggerConflict: false },
      { windowId: 1, tabId: 8, groupId: null, title: 'Chrome settings', origin: 'chrome://settings', active: false, attached: false, restricted: true, debuggerConflict: false },
      { windowId: 1, tabId: 9, groupId: null, title: 'Devtools owned', origin: 'https://conflict.example', active: false, attached: false, restricted: false, debuggerConflict: true },
    ] }] })),
    attach: vi.fn(async (input) => ({ ok: true as const, status: { ...baseStatus, attachment: { sessionAgentId: input.sessionAgentId, profileId: input.profileId, extensionInstanceId: input.extensionInstanceId, profileAlias: 'Work', groupId: input.groupId ?? null, childPolicy: input.childPolicy, tabs: [{ windowId: 1, tabId: input.tabIds[0]!, groupId: input.groupId ?? null, title: 'Attached', origin: 'https://private.example', active: true }], state: 'attached' as const, attachedAt: 'now' } } })),
    detach: vi.fn(async () => ({ ok: true as const, status: baseStatus })),
  }
}

async function render(value: ExternalChromeBridge) {
  window.electronBridge = { windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://local', externalChrome: value }
  await act(async () => { root!.render(createElement(ExternalChromePanel, { sessionAgentId: 'session-1', profileId: 'forge-profile' })); await Promise.resolve(); await Promise.resolve() })
}
function button(label: string): HTMLButtonElement { const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label)); if (!found) throw new Error(`missing ${label}`); return found }
function click(element: Element) { act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))) }

describe('ExternalChromePanel', () => {
  it('keeps candidates local, namespaces equal tab IDs by profile, disables unsafe tabs, and requires confirmation', async () => {
    const value = bridge()
    await render(value)
    expect(container.textContent).toContain('never sent to the backend or model logs')

    click(button('Attach tabs'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(container.textContent).toContain('profile_a private title')
    expect(container.textContent).toContain('Restricted')
    expect(container.textContent).toContain('Debugger conflict')
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(checkboxes.filter((item) => item.disabled)).toHaveLength(2)
    click(checkboxes.find((item) => !item.disabled)!)
    click(button('Review attachment'))
    expect(value.attach).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Confirm local attachment')
    click(button('Confirm and attach'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(value.attach).toHaveBeenCalledWith(expect.objectContaining({ extensionInstanceId: 'profile_a', tabIds: [7], childPolicy: 'manual', confirmed: true }))
    expect(container.textContent).toContain('Detach now from Forge')
    expect(container.textContent).toContain('External tabs stay in Chrome')
  })

  it('does not carry a numeric tab selection across extension instances', async () => {
    const value = bridge()
    await render(value)
    click(button('Attach tabs'))
    await act(async () => { await Promise.resolve() })
    const selectable = [...container.querySelectorAll('input[type="checkbox"]')].find((item) => !(item as HTMLInputElement).disabled)!
    click(selectable)
    expect(container.textContent).toContain('1 selected')
    // Switch using the second namespaced profile card.
    const attachButtons = [...container.querySelectorAll('button')].filter((item) => item.textContent?.includes('Attach tabs'))
    click(attachButtons[1]!)
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('profile_b private title')
    expect(container.textContent).toContain('0 selected')
  })
})
