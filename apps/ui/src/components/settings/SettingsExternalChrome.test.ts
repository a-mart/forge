/** @vitest-environment jsdom */

import { getByRole, waitFor } from '@testing-library/dom'
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
  ;(status as { auth: string }).auth = 'secure'
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  window.electronBridge = { windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://local', externalChrome: {
    status: vi.fn(async () => ({ ok: true, status })), repair: vi.fn(async () => ({ ok: true, status })), revealExtensionFolder: vi.fn(async () => ({ ok: true, status })),
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

  it('refreshes status and repairs an online connection', async () => {
    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    const bridge = window.electronBridge!.externalChrome!
    await waitFor(() => expect(bridge.status).toHaveBeenCalledTimes(1))

    await act(async () => { getByRole(container, 'button', { name: /Refresh/ }).click(); await Promise.resolve() })
    expect(bridge.status).toHaveBeenCalledTimes(2)

    await act(async () => { getByRole(container, 'button', { name: 'Repair' }).click(); await Promise.resolve() })
    expect(bridge.repair).toHaveBeenCalledTimes(1)
  })

  it('reveals the extension folder and reports failed actions', async () => {
    ;(status as { auth: string }).auth = 'missing'
    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    const bridge = window.electronBridge!.externalChrome!
    await waitFor(() => expect(container.textContent).toContain('Show Forge extension folder'))

    await act(async () => { getByRole(container, 'button', { name: /Show Forge extension folder/ }).click(); await Promise.resolve() })
    expect(bridge.revealExtensionFolder).toHaveBeenCalledTimes(1)

    ;(bridge.repair as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: 'not ready' })
    await act(async () => { getByRole(container, 'button', { name: 'Repair' }).click(); await Promise.resolve() })
    expect(getByRole(container, 'alert').textContent).toContain('could not repair')
  })

  it('disables actions while a bridge operation is pending', async () => {
    ;(status as { auth: string }).auth = 'missing'
    let resolveRepair!: (value: unknown) => void
    const pendingRepair = new Promise((resolve) => { resolveRepair = resolve })
    const bridgeRepair = window.electronBridge!.externalChrome!.repair as ReturnType<typeof vi.fn>
    bridgeRepair.mockReturnValueOnce(pendingRepair)

    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    await waitFor(() => expect(container.textContent).toContain('Repair'))
    const repair = getByRole(container, 'button', { name: 'Repair' }) as HTMLButtonElement
    await act(async () => { repair.click(); await Promise.resolve() })
    expect(repair.disabled).toBe(true)
    await act(async () => resolveRepair({ ok: true, status }))
    expect(repair.disabled).toBe(false)
  })

  it('keeps diagnostics collapsed by default', async () => {
    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    expect(container.querySelector('#chrome-advanced-diagnostics')).toBeNull()
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Advanced diagnostics'))!
    act(() => button.click())
    expect(container.querySelector('#chrome-advanced-diagnostics')).not.toBeNull()
  })
})
