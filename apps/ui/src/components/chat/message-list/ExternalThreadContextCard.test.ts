/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalThreadMessageContext } from '@forge/protocol'
import { ExternalThreadContextCard } from './ExternalThreadContextCard'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

function buildContext(
  status: ExternalThreadMessageContext['status'],
): ExternalThreadMessageContext {
  return {
    type: 'codex_app_server',
    sidecarAgentId: 'manager--codex',
    requestId: 'req-1',
    turnCorrelationId: 'turn-1',
    status,
    excludeFromModelContext: true,
    promptPreview: 'Summarize my calendar',
    resultPreview: 'You have two meetings today.',
  }
}

function renderCard(
  status: ExternalThreadMessageContext['status'],
  options?: {
    showStop?: boolean
    onStop?: () => void
    stopDisabled?: boolean
  },
) {
  flushSync(() => {
    root.render(
      createElement(ExternalThreadContextCard, {
        context: buildContext(status),
        text:
          status === 'completed'
            ? 'Codex completed: You have two meetings today.'
            : 'Codex is running: Summarize my calendar',
        timestampLabel: status === 'completed' ? '10:30 AM' : undefined,
        showStop: options?.showStop,
        onStop: options?.onStop,
        stopDisabled: options?.stopDisabled,
      }),
    )
  })
}

function getStopButton(): HTMLButtonElement | null {
  return container.querySelector('button')
}

describe('ExternalThreadContextCard', () => {
  it('renders codex status card with previews', () => {
    renderCard('completed')

    expect(container.textContent).toContain('Codex')
    expect(container.textContent).toContain('Completed')
    expect(container.textContent).toContain('You have two meetings today.')
    expect(container.querySelector('[data-external-thread-status="completed"]')).toBeTruthy()
  })

  it('shows disabled stop control while running when stop is not wired', () => {
    renderCard('running', { showStop: true })

    expect(container.textContent).toContain('Stop')
    expect(getStopButton()?.disabled).toBe(true)
  })

  it('enables stop control while running when handler is wired', () => {
    renderCard('running', { showStop: true, onStop: vi.fn(), stopDisabled: false })

    expect(getStopButton()?.disabled).toBe(false)
  })

  it('keeps stop control disabled when explicitly disabled', () => {
    renderCard('running', { showStop: true, onStop: vi.fn(), stopDisabled: true })

    expect(getStopButton()?.disabled).toBe(true)
  })

  it('calls onStop when enabled stop button is clicked', () => {
    const onStop = vi.fn()
    renderCard('sent', { showStop: true, onStop, stopDisabled: false })

    getStopButton()?.click()

    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('hides stop control on historical sent cards when showStop is false', () => {
    renderCard('sent', { showStop: false, onStop: vi.fn(), stopDisabled: false })

    expect(getStopButton()).toBeNull()
  })

  it('hides stop control on completed cards', () => {
    renderCard('completed', { showStop: false, onStop: vi.fn(), stopDisabled: false })

    expect(getStopButton()).toBeNull()
  })
})
