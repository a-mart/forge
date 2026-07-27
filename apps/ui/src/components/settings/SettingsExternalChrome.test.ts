/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsExternalChrome } from './SettingsExternalChrome'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const status = {
  state: 'online', authority: 'owned', auth: 'secure', registration: 'registered', trust: 'trusted', platform: 'darwin',
  canEnable: false, canDisable: true, canRepair: true, canRollback: false, canRemove: true, canTakeover: false, canReveal: true,
  recovery: 'ready', detail: null,
  setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'ready', loadUnpackedPath: '/tmp/forge-extension' },
}
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  window.electronBridge = { windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://local', externalChrome: {
    status: vi.fn(async () => ({ ok: true, status })), repair: vi.fn(async () => ({ ok: true, status })),
  } as never }
})
afterEach(() => { act(() => root.unmount()); container.remove(); delete window.electronBridge })

describe('SettingsExternalChrome', () => {
  it('presents concise automatic Chrome setup without runtime ceremony', async () => {
    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    expect(container.textContent).toContain('Use Chrome with Forge')
    expect(container.textContent).toContain('No host or tab selection is required')
    expect(container.textContent).not.toMatch(/attach|detach|lease|candidate|group|profile alias/i)
  })

  it('keeps diagnostics collapsed by default', async () => {
    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    expect(container.querySelector('#chrome-advanced-diagnostics')).toBeNull()
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Advanced diagnostics'))!
    act(() => button.click())
    expect(container.querySelector('#chrome-advanced-diagnostics')).not.toBeNull()
  })
})
