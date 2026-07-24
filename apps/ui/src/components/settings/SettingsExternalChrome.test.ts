/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalChromeCoordinatorStatus } from '@forge/protocol'
import type { ElectronBridge, ExternalChromeBridge } from '@/lib/electron-bridge'

vi.mock('@/components/ui/alert-dialog', async () => {
  const { createElement } = await import('react')
  const passthrough = ({ children }: { children?: unknown }) => createElement('div', null, children as never)
  return {
    AlertDialog: ({ open, children }: { open: boolean; children?: unknown }) => open ? createElement('div', { role: 'alertdialog' }, children as never) : null,
    AlertDialogAction: ({ children, ...props }: Record<string, unknown>) => createElement('button', props, children as never),
    AlertDialogCancel: ({ children, ...props }: Record<string, unknown>) => createElement('button', props, children as never),
    AlertDialogContent: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogFooter: passthrough,
    AlertDialogHeader: passthrough,
    AlertDialogTitle: passthrough,
  }
})

const { SettingsExternalChrome } = await import('./SettingsExternalChrome')

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const LOAD_PATH = '/validated/forge/integrations/external-chrome/extension'

function coordinatorStatus(overrides: Partial<ExternalChromeCoordinatorStatus> = {}): ExternalChromeCoordinatorStatus {
  return {
    state: 'disabled',
    authority: 'none',
    auth: 'secure',
    registration: 'owned',
    trust: 'trusted',
    platform: 'darwin',
    canEnable: true,
    canDisable: false,
    canRepair: true,
    canRollback: true,
    canRemove: true,
    canTakeover: false,
    canReveal: true,
    setup: {
      extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd',
      pathState: 'ready',
      loadUnpackedPath: LOAD_PATH,
      packaged: {
        desktopVersion: '0.23.0', packageVersion: '0.23.0',
        shell: { abi: 1, sha256: HASH_A },
        payload: { version: '0.23.0', sha256: HASH_B },
        nativeHost: { version: '0.23.0', sha256: HASH_C },
      },
      deployed: {
        desktopVersion: '0.23.0', packageVersion: '0.23.0',
        shell: { abi: 1, sha256: HASH_A },
        payload: { version: '0.23.0', sha256: HASH_B },
        nativeHost: { sha256: HASH_C },
      },
    },
    ...overrides,
  }
}

function createBridge(status = coordinatorStatus()) {
  const ok = async () => ({ ok: true as const, status })
  return {
    status: vi.fn(ok),
    enable: vi.fn(ok),
    disable: vi.fn(ok),
    repair: vi.fn(ok),
    rollback: vi.fn(ok),
    remove: vi.fn(ok),
    takeover: vi.fn(ok),
    revealExtensionFolder: vi.fn(ok),
  } satisfies ExternalChromeBridge
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let clipboardWrite: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  clipboardWrite = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWrite } })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete window.electronBridge
  vi.restoreAllMocks()
})

async function click(element: Element): Promise<void> {
  await act(async () => { fireEvent.click(element) })
}

async function render(bridge?: ExternalChromeBridge) {
  if (bridge) {
    window.electronBridge = {
      windowRole: 'main', platform: 'darwin', backendWsUrl: 'ws://127.0.0.1', externalChrome: bridge,
    } as ElectronBridge
  }
  await act(async () => root.render(createElement(SettingsExternalChrome)))
  if (bridge) await waitFor(() => expect(bridge.status).toHaveBeenCalledTimes(1))
}

describe('SettingsExternalChrome', () => {
  it('shows the no-store/security/profile/manual-reload ceremony and copies only coordinator-projected values', async () => {
    const bridge = createBridge()
    await render(bridge)

    expect(document.body.textContent).toContain('Unpacked extension — not from the Chrome Web Store')
    expect(document.body.textContent).toContain('Powerful browser permissions')
    expect(document.body.textContent).toContain('dedicated Chrome profile')
    expect(document.body.textContent).toContain('chrome://extensions')
    expect(document.body.textContent).toContain('Developer mode')
    expect(document.body.textContent).toContain('per Chrome profile')
    expect(document.body.textContent).toContain('Reload')
    expect(screen.getByTestId('external-chrome-load-path').textContent).toBe(LOAD_PATH)
    expect(screen.getByTestId('external-chrome-extension-id').textContent).toBe('fcchfcnadajoejfbiclihglkmbcfhajd')
    expect(document.body.textContent).toContain(`sha256:${HASH_A}`)
    expect(document.body.textContent).toContain('Not reported in this setup milestone')

    await click(screen.getByRole('button', { name: 'Copy path' }))
    await click(screen.getByRole('button', { name: 'Copy ID' }))
    await waitFor(() => expect(clipboardWrite).toHaveBeenNthCalledWith(1, LOAD_PATH))
    expect(clipboardWrite).toHaveBeenNthCalledWith(2, 'fcchfcnadajoejfbiclihglkmbcfhajd')

    await click(screen.getByRole('button', { name: 'Reveal folder' }))
    await waitFor(() => expect(bridge.revealExtensionFolder).toHaveBeenCalledTimes(1))
    expect(bridge.revealExtensionFolder).toHaveBeenCalledWith()
  })

  it('requires confirmations for every coordinator state change', async () => {
    const status = coordinatorStatus({
      authority: 'stale', canEnable: true, canDisable: true, canRepair: true, canTakeover: true,
    })
    const bridge = createBridge(status)
    await render(bridge)

    const cases = [
      ['Enable', 'Enable', bridge.enable],
      ['Disable', 'Disable', bridge.disable],
      ['Repair native host', 'Repair', bridge.repair],
      ['Roll back', 'Roll back', bridge.rollback],
      ['Take over stale owner', 'Take over', bridge.takeover],
      ['Remove integration', 'Remove integration', bridge.remove],
    ] as const

    for (const [buttonName, confirmName, method] of cases) {
      const actionButton = screen.getByRole('button', { name: buttonName }) as HTMLButtonElement
      await waitFor(() => expect(actionButton.disabled).toBe(false))
      await click(actionButton)
      const dialog = await screen.findByRole('alertdialog')
      await click(within(dialog).getByRole('button', { name: confirmName }))
      await waitFor(() => expect(method).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    }
  })

  it('truthfully disables unsafe actions for another live owner and a mismatched deployment', async () => {
    const bridge = createBridge(coordinatorStatus({
      state: 'other-instance', authority: 'other-live', registration: 'needs-repair', trust: 'untrusted',
      canEnable: false, canDisable: false, canRepair: false, canRollback: false, canRemove: false, canTakeover: false, canReveal: false,
      setup: {
        extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd',
        pathState: 'mismatch',
      },
    }))
    await render(bridge)

    expect(document.body.textContent).toContain('untrusted — repair blocked')
    expect(document.body.textContent).toContain('Another live Forge Desktop instance owns the coordinator')
    expect(document.body.textContent).toContain('failed integrity, identity, compatibility, or path validation')
    expect(document.body.textContent).toContain('Load unpacked folder not ready')
    expect(document.body.textContent).not.toContain('Validated Load unpacked folder')
    for (const name of ['Enable', 'Disable', 'Repair native host', 'Roll back', 'Take over stale owner', 'Remove integration']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.queryByRole('button', { name: 'Reveal folder' })).toBeNull()
  })

  it('defensively blocks enable when corrupt deployment status is inconsistent', async () => {
    const bridge = createBridge(coordinatorStatus({
      canEnable: true,
      setup: { extensionId: 'fcchfcnadajoejfbiclihglkmbcfhajd', pathState: 'mismatch' },
    }))
    await render(bridge)
    expect((screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).not.toContain('Validated Load unpacked folder')
  })

  it('does not expose coordinator actions outside Forge Desktop', async () => {
    await render()
    expect(document.body.textContent).toContain('available only in the main Forge Desktop window')
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  })
})
