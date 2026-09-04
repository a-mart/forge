/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { makeManagerSelectionCatalog } from './manager-selection-catalog.fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const catalogApiMock = vi.hoisted(() => ({
  fetchManagerSelectionCatalog: vi.fn(),
}))

vi.mock('./manager-selection-catalog-api', () => ({
  fetchManagerSelectionCatalog: (...args: unknown[]) =>
    catalogApiMock.fetchManagerSelectionCatalog(...args),
}))

const {
  invalidateManagerSelectionCatalog,
  useManagerSelectionCatalog,
} = await import('./use-manager-selection-catalog')

const apiClient = { target: { kind: 'builder' } } as unknown as SettingsApiClient
let container: HTMLDivElement
let root: Root | null = null

function Consumer({
  id,
  originId,
  modelConfigChangeKey,
  connectionEpoch,
  enabled = true,
  forceOnEnabled = false,
}: {
  id: string
  originId: string
  modelConfigChangeKey: number
  connectionEpoch: number
  enabled?: boolean
  forceOnEnabled?: boolean
}) {
  const result = useManagerSelectionCatalog({
    originId,
    enabled,
    client: apiClient,
    modelConfigChangeKey,
    connectionEpoch,
    forceOnEnabled,
  })
  return createElement('span', { 'data-testid': id }, [
    result.catalog?.revision ?? 'none',
    result.loading ? ':loading' : ':idle',
    result.error ? `:${result.error}` : '',
  ].join(''))
}

function Harness(props: {
  originId?: string
  modelConfigChangeKey: number
  connectionEpoch: number
  consumers?: number
  enabled?: boolean
  forceOnEnabled?: boolean
}) {
  return createElement('div', null, Array.from({ length: props.consumers ?? 2 }, (_, index) =>
    createElement(Consumer, {
      key: index,
      id: `consumer-${index}`,
      originId: props.originId ?? 'local',
      modelConfigChangeKey: props.modelConfigChangeKey,
      connectionEpoch: props.connectionEpoch,
      enabled: props.enabled,
      forceOnEnabled: props.forceOnEnabled,
    }),
  ))
}

async function renderHarness(props: Parameters<typeof Harness>[0]): Promise<void> {
  await act(async () => {
    root?.render(createElement(Harness, props))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  invalidateManagerSelectionCatalog()
  catalogApiMock.fetchManagerSelectionCatalog.mockReset()
  catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
  }
  root = null
  container.remove()
  invalidateManagerSelectionCatalog()
})

describe('useManagerSelectionCatalog cache', () => {
  it('shares one validated snapshot request across consumers and remounts', async () => {
    await renderHarness({ modelConfigChangeKey: 0, connectionEpoch: 1 })

    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="consumer-0"]')?.textContent).toBe('msc-v1-test:idle')
    expect(container.querySelector('[data-testid="consumer-1"]')?.textContent).toBe('msc-v1-test:idle')

    await renderHarness({ modelConfigChangeKey: 0, connectionEpoch: 1, consumers: 1 })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(1)
  })

  it('refreshes once per model_config_changed invalidation and reconnect epoch', async () => {
    catalogApiMock.fetchManagerSelectionCatalog
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'initial' }))
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'config-changed' }))
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'reconnected' }))

    await renderHarness({ modelConfigChangeKey: 0, connectionEpoch: 1 })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(1)

    await renderHarness({ modelConfigChangeKey: 1, connectionEpoch: 1 })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('config-changed')

    await renderHarness({ modelConfigChangeKey: 1, connectionEpoch: 2 })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('reconnected')
  })

  it('keeps origin caches isolated', async () => {
    catalogApiMock.fetchManagerSelectionCatalog
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'local-revision' }))
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'remote-revision' }))

    await renderHarness({ originId: 'local', modelConfigChangeKey: 0, connectionEpoch: 1, consumers: 1 })
    await renderHarness({ originId: 'remote-a', modelConfigChangeKey: 0, connectionEpoch: 1, consumers: 1 })

    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('remote-revision')
  })

  it('fails closed after an invalidated refresh fails', async () => {
    catalogApiMock.fetchManagerSelectionCatalog
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'initial' }))
      .mockRejectedValueOnce(new Error('catalog unavailable'))

    await renderHarness({ modelConfigChangeKey: 0, connectionEpoch: 1, consumers: 1 })
    await renderHarness({ modelConfigChangeKey: 1, connectionEpoch: 1, consumers: 1 })

    expect(container.textContent).toBe('none:idle:catalog unavailable')
  })

  it('forces a validated fetch when a selector reopens without reconnect', async () => {
    catalogApiMock.fetchManagerSelectionCatalog
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'stale-enabled' }))
      .mockResolvedValueOnce(makeManagerSelectionCatalog({ revision: 'disabled-without-reconnect' }))

    await renderHarness({
      modelConfigChangeKey: 0,
      connectionEpoch: 1,
      consumers: 1,
      enabled: true,
      forceOnEnabled: true,
    })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('stale-enabled')

    await renderHarness({
      modelConfigChangeKey: 0,
      connectionEpoch: 1,
      consumers: 1,
      enabled: false,
      forceOnEnabled: true,
    })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(1)

    await renderHarness({
      modelConfigChangeKey: 0,
      connectionEpoch: 1,
      consumers: 1,
      enabled: true,
      forceOnEnabled: true,
    })
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('disabled-without-reconnect')
  })
})
