/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAbout } from './SettingsAbout'

vi.mock('./settings-api', () => ({
  fetchServerVersion: vi.fn(async () => '0.22.0-beta.4'),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.electronBridge
})

async function renderAbout(): Promise<void> {
  await act(async () => {
    root.render(createElement(SettingsAbout, { wsUrl: 'ws://127.0.0.1:47287' }))
    await Promise.resolve()
  })
}

describe('SettingsAbout Electron runtime details', () => {
  it('shows the development runtime and Electron process start time', async () => {
    const startedAt = '2026-07-28T15:00:00.000Z'
    window.electronBridge = {
      windowRole: 'main',
      platform: 'darwin',
      backendWsUrl: 'ws://127.0.0.1:47287',
      getVersion: () => '0.22.0-beta.4',
      appRuntime: 'development',
      appStartedAt: startedAt,
    }

    await renderAbout()

    expect(container.textContent).toContain('Electron dev')
    const startedTime = container.querySelector('time')
    expect(startedTime?.dateTime).toBe(startedAt)
    expect(startedTime?.textContent).not.toBe('Unknown')
  })

  it('identifies the packaged runtime as the installed Electron app', async () => {
    window.electronBridge = {
      windowRole: 'main',
      platform: 'darwin',
      backendWsUrl: 'ws://127.0.0.1:47287',
      getVersion: () => '0.22.0-beta.4',
      appRuntime: 'installed',
      appStartedAt: '2026-07-28T15:00:00.000Z',
    }

    await renderAbout()

    expect(container.textContent).toContain('Installed Electron app')
  })
})
