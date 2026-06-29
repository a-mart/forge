/** @vitest-environment jsdom */

import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageFeedback } from './MessageFeedback'

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
  document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove())
})

function renderFeedback(
  props: Partial<ComponentProps<typeof MessageFeedback>> = {},
) {
  const onVote = props.onVote ?? vi.fn().mockResolvedValue(undefined)
  flushSync(() => {
    root.render(
      createElement(MessageFeedback, {
        targetId: 'msg-1',
        currentVote: null,
        onVote,
        ...props,
      }),
    )
  })
  return { onVote }
}

function click(element: Element | null) {
  expect(element).toBeTruthy()
  flushSync(() => {
    ;(element as HTMLElement).click()
  })
}

function getButtonByText(text: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  ) ?? null
}

describe('MessageFeedback', () => {
  it('opens a compact feedback menu from one neutral trigger', () => {
    renderFeedback({ onComment: vi.fn().mockResolvedValue(undefined) })

    const trigger = container.querySelector('button[aria-label="Give feedback"]') as HTMLButtonElement | null
    expect(trigger?.title).toBe('Give feedback')
    click(trigger)

    expect(document.body.textContent).toContain('Good response')
    expect(document.body.textContent).toContain('Needs work')
    expect(document.body.textContent).toContain('Add comment')
  })

  it('submits a good-response vote from the menu', () => {
    const onVote = vi.fn().mockResolvedValue(undefined)
    renderFeedback({ onVote })

    click(container.querySelector('button[aria-label="Give feedback"]'))
    click(getButtonByText('Good response'))

    expect(onVote).toHaveBeenCalledTimes(1)
    expect(onVote).toHaveBeenCalledWith('message', 'msg-1', 'up', undefined, undefined, undefined)
  })

  it('opens needs-work details and submits a downvote', () => {
    const onVote = vi.fn().mockResolvedValue(undefined)
    renderFeedback({ onVote })

    click(container.querySelector('button[aria-label="Give feedback"]'))
    click(getButtonByText('Needs work'))

    expect(document.body.textContent).toContain('What went wrong?')
    click(getButtonByText('Submit'))

    expect(onVote).toHaveBeenCalledWith('message', 'msg-1', 'down', [], undefined, undefined)
  })

  it('opens comment entry and submits comment text', () => {
    const onComment = vi.fn().mockResolvedValue(undefined)
    renderFeedback({ onComment })

    click(container.querySelector('button[aria-label="Give feedback"]'))
    click(getButtonByText('Add comment'))

    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement | null
    expect(textarea).toBeTruthy()
    flushSync(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(textarea, 'Helpful context')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(getButtonByText('Submit'))

    expect(onComment).toHaveBeenCalledWith('message', 'msg-1', 'Helpful context', undefined)
  })

  it('reflects active vote and comment state on the trigger', () => {
    renderFeedback({ currentVote: 'up', hasComment: true })

    const trigger = container.querySelector('button[aria-label="Feedback: good response"]') as HTMLButtonElement | null
    expect(trigger).toBeTruthy()
    expect(trigger?.getAttribute('aria-pressed')).toBe('true')
    expect(trigger?.title).toBe('Feedback: good response')
  })

  it('removes an existing upvote from the detail flow', () => {
    const onVote = vi.fn().mockResolvedValue(undefined)
    renderFeedback({ currentVote: 'up', onVote })

    click(container.querySelector('button[aria-label="Feedback: good response"]'))
    click(getButtonByText('Good response'))
    click(getButtonByText('Remove'))

    expect(onVote).toHaveBeenCalledWith('message', 'msg-1', 'up', undefined, undefined, undefined)
  })

  it('removes an existing downvote from the detail flow', () => {
    const onVote = vi.fn().mockResolvedValue(undefined)
    renderFeedback({ currentVote: 'down', onVote })

    click(container.querySelector('button[aria-label="Feedback: needs work"]'))
    click(getButtonByText('Needs work'))
    click(getButtonByText('Remove'))

    expect(onVote).toHaveBeenCalledWith('message', 'msg-1', 'down', undefined, undefined, undefined)
  })

  it('removes an existing comment from the comment flow', () => {
    const onComment = vi.fn().mockResolvedValue(undefined)
    const onClearComment = vi.fn().mockResolvedValue(undefined)
    renderFeedback({ hasComment: true, onComment, onClearComment })

    click(container.querySelector('button[aria-label="Feedback: comment added"]'))
    click(getButtonByText('Add/update comment'))
    click(getButtonByText('Remove'))

    expect(onClearComment).toHaveBeenCalledWith('message', 'msg-1', undefined)
  })
})
