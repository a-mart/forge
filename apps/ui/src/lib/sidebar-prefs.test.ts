/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PREFERENCE_CHANGE_EVENT,
  readSidebarLayoutPref,
  SIDEBAR_LAYOUT_KEY,
  storeSidebarLayoutPref,
} from './sidebar-prefs'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('sidebar layout preference', () => {
  it('defaults to Classic when the rollout preference is unset or invalid', () => {
    expect(readSidebarLayoutPref()).toBe('classic')
    localStorage.setItem(SIDEBAR_LAYOUT_KEY, 'unknown')
    expect(readSidebarLayoutPref()).toBe('classic')
  })

  it('persists Rooms v2 and announces the shared sidebar preference change', () => {
    const listener = vi.fn()
    window.addEventListener(PREFERENCE_CHANGE_EVENT, listener)

    storeSidebarLayoutPref('rooms-v2')

    expect(localStorage.getItem(SIDEBAR_LAYOUT_KEY)).toBe('rooms-v2')
    expect(readSidebarLayoutPref()).toBe('rooms-v2')
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      detail: { key: SIDEBAR_LAYOUT_KEY, value: 'rooms-v2' },
    }))
    window.removeEventListener(PREFERENCE_CHANGE_EVENT, listener)
  })
})
