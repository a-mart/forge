/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useElectronRendererReady } from './use-electron-renderer-ready'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function ReadyProbe() {
  useElectronRendererReady()
  return null
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  delete window.electronBridge
})

describe('useElectronRendererReady', () => {
  it('signals readiness after the main Electron surface mounts', async () => {
    const markRendererReady = vi.fn()
    window.electronBridge = {
      windowRole: 'main',
      platform: 'darwin',
      markRendererReady,
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(ReadyProbe))
      await Promise.resolve()
    })

    expect(markRendererReady).toHaveBeenCalledOnce()
  })

  it('does not signal from the managed browser popout', async () => {
    const markRendererReady = vi.fn()
    window.electronBridge = {
      windowRole: 'managed-browser-popout',
      platform: 'darwin',
      markRendererReady,
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(ReadyProbe))
      await Promise.resolve()
    })

    expect(markRendererReady).not.toHaveBeenCalled()
  })
})
