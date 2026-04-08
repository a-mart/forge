/** @vitest-environment jsdom */

import { getAllByText, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HelpProvider } from '@/components/help/HelpProvider'
import { SettingsExtensions } from './SettingsExtensions'

const settingsApiMock = vi.hoisted(() => ({
  fetchSettingsExtensions: vi.fn(),
  toErrorMessage: vi.fn((error: unknown) => String(error)),
}))

vi.mock('./settings-api', () => ({
  fetchSettingsExtensions: (...args: Parameters<typeof settingsApiMock.fetchSettingsExtensions>) =>
    settingsApiMock.fetchSettingsExtensions(...args),
  toErrorMessage: (...args: Parameters<typeof settingsApiMock.toErrorMessage>) =>
    settingsApiMock.toErrorMessage(...args),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

describe('SettingsExtensions', () => {
  it('renders Forge and Pi sections from the combined payload', async () => {
    settingsApiMock.fetchSettingsExtensions.mockResolvedValue({
      generatedAt: '2026-04-07T00:00:00.000Z',
      discovered: [
        {
          displayName: 'worker-ext.ts',
          path: '/tmp/pi/worker-ext.ts',
          source: 'global-worker',
        },
      ],
      snapshots: [
        {
          agentId: 'manager',
          role: 'manager',
          managerId: 'manager',
          profileId: 'manager',
          loadedAt: '2026-04-07T00:00:00.000Z',
          extensions: [
            {
              displayName: 'worker-ext.ts',
              path: '/tmp/pi/worker-ext.ts',
              resolvedPath: '/tmp/pi/worker-ext.ts',
              source: 'global-worker',
              events: ['tool_call'],
              tools: ['bash'],
            },
          ],
          loadErrors: [],
        },
      ],
      directories: {
        globalWorker: '/tmp/pi/worker',
        globalManager: '/tmp/pi/manager',
        profileTemplate: '/tmp/data/profiles/<profileId>/pi/extensions',
        projectLocalRelative: '.pi/extensions',
      },
      forge: {
        discovered: [
          {
            displayName: 'protect-env.ts',
            path: '/tmp/forge/protect-env.ts',
            scope: 'global',
            name: 'protect-env',
            description: 'Protect env files',
          },
          {
            displayName: 'broken-ext.ts',
            path: '/tmp/forge/broken-ext.ts',
            scope: 'profile',
            profileId: 'manager',
            loadError: 'Forge extension default export must be a function',
          },
        ],
        snapshots: [
          {
            agentId: 'manager',
            role: 'manager',
            managerId: 'manager',
            profileId: 'manager',
            runtimeType: 'pi',
            loadedAt: '2026-04-07T00:00:00.000Z',
            extensions: [
              {
                displayName: 'protect-env.ts',
                path: '/tmp/forge/protect-env.ts',
                scope: 'global',
                name: 'protect-env',
                hooks: ['tool:before'],
              },
            ],
          },
        ],
        recentErrors: [
          {
            timestamp: '2026-04-07T00:00:00.000Z',
            phase: 'load',
            message: 'Failed to initialize extension',
            path: '/tmp/forge/broken-ext.ts',
            runtimeType: 'pi',
          },
        ],
        directories: {
          global: '/tmp/forge/global',
          profileTemplate: '/tmp/data/profiles/<profileId>/extensions',
          projectLocalRelative: '.forge/extensions',
        },
      },
    })

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(
          HelpProvider,
          null,
          createElement(SettingsExtensions, {
            wsUrl: 'ws://127.0.0.1:47187',
          }),
        ),
      )
    })

    await flushPromises()
    await flushPromises()

    expect(getByText(container, 'Forge Extensions')).toBeTruthy()
    expect(getByText(container, 'Pi Extensions & Packages')).toBeTruthy()
    expect(getAllByText(container, 'protect-env').length).toBeGreaterThan(0)
    expect(getByText(container, 'Protect env files')).toBeTruthy()
    expect(getByText(container, 'Failed to initialize extension')).toBeTruthy()
    expect(queryByText(container, 'No recent Forge extension errors.')).toBeNull()
    expect(getByText(container, 'worker-ext.ts')).toBeTruthy()
    expect(getByText(container, 'Pi extension documentation →')).toBeTruthy()
    expect(getByText(container, 'Forge extension documentation →')).toBeTruthy()
    expect(queryByText(container, 'No active Forge runtime bindings yet.')).toBeNull()
  })
})
