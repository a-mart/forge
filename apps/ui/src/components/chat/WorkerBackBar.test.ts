/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerBackBar } from './WorkerBackBar'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

describe('WorkerBackBar', () => {
  it('shows the shared team Secure Bash status and navigates to its manager', () => {
    const onNavigateBack = vi.fn()
    flushSync(() => {
      root.render(createElement(WorkerBackBar, {
        managerLabel: 'Release manager',
        onNavigateBack,
        secureStatus: {
          active: true,
          label: 'Team Secure Bash · 2 grants',
        },
      }))
    })

    expect(getByRole(container, 'button', {
      name: 'Back to Release manager',
    })).toBeTruthy()
    expect(container.textContent).toContain('Team Secure Bash · 2 grants')
    expect(container.querySelector(
      '[aria-label="Team Secure Bash: Team Secure Bash · 2 grants"]',
    )).not.toBeNull()

    fireEvent.click(getByRole(container, 'button', {
      name: 'Back to Release manager',
    }))
    expect(onNavigateBack).toHaveBeenCalledTimes(1)
  })
})
