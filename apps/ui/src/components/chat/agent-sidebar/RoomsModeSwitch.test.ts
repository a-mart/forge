/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomsModeSwitch } from './RoomsModeSwitch'

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root?.unmount())
  root = null
  container.remove()
})

describe('RoomsModeSwitch', () => {
  it('reports the active mode and the distinct Needs You badge', () => {
    const onChange = vi.fn()
    flushSync(() => root?.render(createElement(RoomsModeSwitch, {
      mode: 'inbox',
      needsYouCount: 3,
      onChange,
    })))

    expect(container.querySelector('[data-testid="rooms-mode-switch"]')?.getAttribute('aria-label')).toBe('New project view sidebar mode')
    expect(getByRole(container, 'button', { name: /inbox/i }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole(container, 'button', { name: /inbox/i }).textContent).toContain('3')
    expect(container.querySelector('[aria-label="3 sessions need you"]')?.classList.contains('sidebar-room-unread-badge')).toBe(true)
    fireEvent.click(getByRole(container, 'button', { name: 'Projects' }))
    expect(onChange).toHaveBeenCalledWith('projects')
  })
})
