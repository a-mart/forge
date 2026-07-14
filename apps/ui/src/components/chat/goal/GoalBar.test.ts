/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGoalSnapshotEvent } from '@forge/protocol'
import { GoalBar } from './GoalBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const snapshot: SessionGoalSnapshotEvent = {
  type: 'session_goal_snapshot',
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  revision: 3,
  measuredAt: new Date().toISOString(),
  goal: {
    id: 'goal-1',
    objective: 'Ship the simple durable goal system',
    status: 'active',
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:00.000Z',
    tokenBudget: 10_000,
    activeElapsedMs: 65_000,
    turnCount: 2,
    usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0, total: 1_500 },
    usageCoverage: 'complete',
    remainingTokens: 8_500,
  },
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('GoalBar', () => {
  it('keeps the active objective visible and exposes pause and detail controls', () => {
    const onAction = vi.fn()
    act(() => root.render(createElement(GoalBar, { snapshot, onAction })))

    expect(container.textContent).toContain('Pursuing goal')
    expect(container.textContent).toContain('Ship the simple durable goal system')
    expect(container.textContent).toContain('1:05')
    expect(container.textContent).toContain('1.5k / 10k')

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Pause goal"]')!.click())
    expect(onAction).toHaveBeenCalledWith({ action: 'pause' })

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Expand goal details"]')!.click())
    expect(container.textContent).toContain('2 goal turns')
    expect(container.textContent).toContain('1.5k tokens')
  })

  it('lets the user resume a paused goal and edit its current values', () => {
    const onAction = vi.fn()
    const paused = {
      ...snapshot,
      revision: 4,
      goal: snapshot.goal && { ...snapshot.goal, status: 'paused' as const, pauseReason: 'user' as const },
    }
    act(() => root.render(createElement(GoalBar, { snapshot: paused, onAction })))

    expect(container.textContent).toContain('Goal paused')
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Resume goal"]')!.click())
    expect(onAction).toHaveBeenCalledWith({ action: 'resume' })

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!.click())
    expect(container.querySelector<HTMLInputElement>('[aria-label="Goal objective"]')?.value)
      .toBe('Ship the simple durable goal system')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Goal token budget"]')?.value).toBe('10000')
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Save'))
    act(() => save!.click())
    expect(onAction).toHaveBeenCalledWith({
      action: 'edit',
      objective: 'Ship the simple durable goal system',
      tokenBudget: 10_000,
    })
  })

  it('hides terminal goals and empty snapshots', () => {
    act(() => root.render(createElement(GoalBar, {
      snapshot: {
        ...snapshot,
        goal: snapshot.goal && { ...snapshot.goal, status: 'completed' as const },
      },
      onAction: vi.fn(),
    })))
    expect(container.textContent).toBe('')

    act(() => root.render(createElement(GoalBar, { snapshot: null, onAction: vi.fn() })))
    expect(container.textContent).toBe('')
  })
})
