/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ManagerToolActivityIndicator } from './ManagerToolActivityIndicator'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ManagerToolActivityIndicator', () => {
  it('renders the latest count and normalized tool name at the live conversation edge', () => {
    act(() => {
      root.render(createElement(ManagerToolActivityIndicator, {
        activity: {
          type: 'manager_tool_activity',
          sessionAgentId: 'manager-1',
          revision: 2,
          toolCount: 3,
          currentToolName: 'read_file',
        },
      }))
    })

    const indicator = container.querySelector('[data-testid="manager-tool-activity"]')
    expect(indicator?.textContent).toContain('Using tools')
    expect(indicator?.textContent).toContain('3 tools')
    expect(indicator?.textContent).toContain('read_file')
    expect(indicator?.getAttribute('aria-label')).toBe('Manager tool activity: 3 tools, read_file')
    expect(indicator?.getAttribute('role')).toBe('status')
  })

  it('stays hidden when activity is empty', () => {
    act(() => {
      root.render(createElement(ManagerToolActivityIndicator, {
        activity: {
          type: 'manager_tool_activity',
          sessionAgentId: 'manager-1',
          revision: 3,
          toolCount: 0,
        },
      }))
    })

    expect(container.querySelector('[data-testid="manager-tool-activity"]')).toBeNull()
  })
})
