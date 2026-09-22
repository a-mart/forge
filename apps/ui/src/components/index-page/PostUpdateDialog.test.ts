/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  applyRecommendedManagerDefaults: vi.fn(),
}))

vi.mock('@/lib/manager-selection-catalog-api', () => ({
  applyRecommendedManagerDefaults: (...args: unknown[]) =>
    apiMock.applyRecommendedManagerDefaults(...args),
}))

const { PostUpdateDialog } = await import('./PostUpdateDialog')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMock.applyRecommendedManagerDefaults.mockReset()
  apiMock.applyRecommendedManagerDefaults.mockResolvedValue({
    profileIds: ['one', 'two'],
    rosterId: 'default',
    rosterRevision: 1,
  })
  window.electronBridge = {
    windowRole: 'main',
    platform: 'darwin',
    getPostUpdateInfo: vi.fn(async () => ({
      previousVersion: '1.0.0',
      currentVersion: '1.1.0',
      offerRecommendedDefaults: true,
    })),
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  container.remove()
  delete window.electronBridge
})

describe('PostUpdateDialog', () => {
  it('presents and applies the recommended defaults from the update prompt', async () => {
    await act(async () => {
      root.render(createElement(PostUpdateDialog, { source: 'ws://127.0.0.1:47187' }))
    })

    expect(getByRole(document.body, 'dialog').textContent).toContain('GPT-6 Sol · High')
    expect(getByRole(document.body, 'dialog').textContent).toContain('Hands-on')
    expect(getByRole(document.body, 'dialog').textContent).toContain('Default')

    await act(async () => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Use recommended defaults' }))
    })

    expect(apiMock.applyRecommendedManagerDefaults).toHaveBeenCalledWith('ws://127.0.0.1:47187')
    expect(getByRole(document.body, 'dialog').textContent).toContain(
      'Recommended defaults applied to 2 user projects.',
    )
  })

  it('does not render outside a post-update launch', async () => {
    window.electronBridge!.getPostUpdateInfo = vi.fn(async () => null)
    await act(async () => {
      root.render(createElement(PostUpdateDialog, { source: 'ws://127.0.0.1:47187' }))
    })
    expect(queryByRole(document.body, 'dialog')).toBeNull()
  })
})
