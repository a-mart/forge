/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliAccessKeyDescriptor } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

const cliAccessApiMock = vi.hoisted(() => ({
  fetchCliAccessKeys: vi.fn(),
  generateCliAccessKey: vi.fn(),
  revokeCliAccessKey: vi.fn(),
  rotateCliAccessKey: vi.fn(),
}))

vi.mock('./cli-access-api', () => cliAccessApiMock)
vi.mock('@/lib/electron-bridge', () => ({ isElectron: () => false }))

import { SettingsCliAccess } from './SettingsCliAccess'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null

function key(id: string, createdAt: string, revokedAt?: string): CliAccessKeyDescriptor {
  return { id, name: id, createdAt, ...(revokedAt ? { revokedAt } : {}) }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  cliAccessApiMock.fetchCliAccessKeys.mockResolvedValue([
    key('revoked-oldest', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
    key('active-first', '2026-04-01T00:00:00.000Z'),
    key('revoked-middle', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
    key('revoked-newest', '2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z'),
    key('active-second', '2026-02-01T00:00:00.000Z'),
    key('revoked-second-newest', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
  ])
  root = createRoot(container)
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

describe('SettingsCliAccess', () => {
  it('shows every active key but only the three most recently revoked keys', async () => {
    await act(async () => {
      root?.render(createElement(SettingsCliAccess, {
        wsUrl: 'ws://127.0.0.1:47187',
        apiClient: {} as SettingsApiClient,
      }))
    })
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('active-first')
    expect(text).toContain('active-second')
    expect(text).toContain('revoked-newest')
    expect(text).toContain('revoked-middle')
    expect(text).toContain('revoked-second-newest')
    expect(text).not.toContain('revoked-oldest')
    expect(text.match(/Revoked/g)).toHaveLength(3)
  })
})
