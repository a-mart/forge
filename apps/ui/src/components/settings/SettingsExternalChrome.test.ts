/** @vitest-environment jsdom */

import { getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalChromeCoordinatorStatus } from '@forge/protocol'
import { SettingsExternalChrome } from './SettingsExternalChrome'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let currentStatus: ExternalChromeCoordinatorStatus

function status(overrides: Partial<ExternalChromeCoordinatorStatus> = {}): ExternalChromeCoordinatorStatus {
  return {
    state: 'online', authority: 'owned', auth: 'secure', registration: 'owned', trust: 'trusted', platform: 'darwin',
    canEnable: false, canDisable: true, canRepair: true, canRollback: false, canRemove: true, canTakeover: false, canReveal: true,
    recovery: 'ready',
    setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'ready', loadUnpackedPath: '/tmp/forge-extension' },
    ...overrides,
  }
}

beforeEach(() => {
  currentStatus = status()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  window.electronBridge = { windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://local', externalChrome: {
    status: vi.fn(async () => ({ ok: true, status: currentStatus })),
    enable: vi.fn(async () => ({ ok: true, status: currentStatus })),
    repair: vi.fn(async () => ({ ok: true, status: currentStatus })),
    revealExtensionFolder: vi.fn(async () => ({ ok: true, status: currentStatus })),
  } as never }
})
afterEach(() => { act(() => root.unmount()); container.remove(); delete window.electronBridge })

function bridge() {
  return window.electronBridge!.externalChrome as unknown as {
    status: ReturnType<typeof vi.fn>
    enable: ReturnType<typeof vi.fn>
    repair: ReturnType<typeof vi.fn>
    revealExtensionFolder: ReturnType<typeof vi.fn>
  }
}

async function render(): Promise<void> {
  await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
  await waitFor(() => expect(bridge().status).toHaveBeenCalledTimes(1))
}

describe('SettingsExternalChrome', () => {
  it('shows authenticated Chrome as ready without setup or repair actions', async () => {
    await render()
    expect(container.textContent).toContain('Chrome is ready for Forge')
    expect(container.textContent).toContain('No host or tab selection is required')
    expect(container.textContent).not.toMatch(/attach|detach|lease|candidate|group|profile alias/i)
    expect(queryByRole(container, 'button', { name: 'Repair' })).toBeNull()
    expect(queryByRole(container, 'button', { name: 'Show Forge extension folder' })).toBeNull()
  })

  it('gives a fresh install the folder-first setup flow rather than Repair', async () => {
    currentStatus = status({
      state: 'disabled', authority: 'none', auth: 'missing', registration: 'not-registered',
      canEnable: true, canDisable: false, canRepair: false, canRemove: false,
    })
    await render()

    expect(container.textContent).toContain('Set up Chrome')
    expect(container.textContent).toContain('enable Developer mode')
    expect(container.textContent).toContain('Load unpacked')
    expect(container.textContent).toContain('not its parent')
    expect(queryByRole(container, 'button', { name: 'Repair' })).toBeNull()

    await act(async () => { getByRole(container, 'button', { name: 'Show Forge extension folder' }).click(); await Promise.resolve() })
    expect(bridge().revealExtensionFolder).toHaveBeenCalledOnce()

    await act(async () => { getByRole(container, 'button', { name: 'Use Chrome with Forge' }).click(); await Promise.resolve() })
    expect(bridge().enable).toHaveBeenCalledOnce()
  })

  it('keeps Repair for an installed integration that is genuinely broken', async () => {
    currentStatus = status({
      state: 'disabled', authority: 'none', auth: 'invalid', registration: 'needs-repair',
      canEnable: false, canDisable: false, canRepair: true, canRemove: true, canReveal: false,
      setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'mismatch' },
    })
    await render()

    expect(container.textContent).toContain('Repair Chrome setup')
    expect(queryByRole(container, 'button', { name: 'Show Forge extension folder' })).toBeNull()
    await act(async () => { getByRole(container, 'button', { name: 'Repair' }).click(); await Promise.resolve() })
    expect(bridge().repair).toHaveBeenCalledOnce()
  })

  it('does not mislabel unavailable setup resources as repairable', async () => {
    currentStatus = status({
      state: 'disabled', authority: 'none', auth: 'missing', registration: 'not-registered', trust: 'missing',
      canEnable: false, canDisable: false, canRepair: false, canRemove: false, canReveal: false,
      setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'missing' },
    })
    await render()

    expect(container.textContent).toContain('Chrome setup is unavailable')
    expect(container.textContent).toContain('embedded browser')
    expect(queryByRole(container, 'button', { name: 'Repair' })).toBeNull()
    expect(queryByRole(container, 'button', { name: 'Show Forge extension folder' })).toBeNull()
  })

  it('reports a status IPC failure without offering an invented setup action', async () => {
    bridge().status.mockResolvedValueOnce({ ok: false, error: 'operation-failed' })
    await act(async () => { root.render(createElement(SettingsExternalChrome)); await Promise.resolve() })
    await waitFor(() => expect(getByRole(container, 'alert').textContent).toContain('Chrome setup status is unavailable'))
    expect(queryByRole(container, 'button', { name: 'Repair' })).toBeNull()
  })

  it('refreshes status and keeps diagnostics collapsed by default', async () => {
    await render()
    expect(container.querySelector('#chrome-advanced-diagnostics')).toBeNull()
    await act(async () => { getByRole(container, 'button', { name: /Refresh/ }).click(); await Promise.resolve() })
    expect(bridge().status).toHaveBeenCalledTimes(2)
    const diagnostics = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Advanced diagnostics'))!
    act(() => diagnostics.click())
    expect(container.querySelector('#chrome-advanced-diagnostics')).not.toBeNull()
  })
})
