/** @vitest-environment jsdom */

import { getByDisplayValue, getByRole } from '@testing-library/dom'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingCallout } from './OnboardingCallout'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

function renderCallout(props: Partial<ComponentProps<typeof OnboardingCallout>> = {}) {
  root = createRoot(container)
  const onSave = props.onSave ?? vi.fn()
  const onSkipForNow = props.onSkipForNow ?? vi.fn()
  const onCreateManager = props.onCreateManager ?? vi.fn()

  flushSync(() => {
    root?.render(
      createElement(OnboardingCallout, {
        mode: 'first-launch',
        state: {
          status: 'pending',
          completedAt: null,
          skippedAt: null,
          preferences: null,
        },
        onSave,
        onSkipForNow,
        onCreateManager,
        ...props,
      }),
    )
  })

  return {
    onSave,
    onSkipForNow,
    onCreateManager,
  }
}

describe('OnboardingCallout', () => {
  it('renders the welcome form fields in first-launch mode', () => {
    renderCallout()

    expect(getByRole(container, 'textbox', { name: 'Name' })).toBeTruthy()
    expect(getByRole(container, 'combobox', { name: 'Technical Level' })).toBeTruthy()
    expect(getByRole(container, 'textbox', { name: 'Additional preferences' })).toBeTruthy()
    expect(getByRole(container, 'button', { name: 'Save & Continue' })).toBeTruthy()
  })

  it('fires the skip action in first-launch mode', () => {
    const { onSkipForNow } = renderCallout()

    const skipButton = getByRole(container, 'button', { name: 'Skip for now' })
    flushSync(() => {
      skipButton.click()
    })

    expect(onSkipForNow).toHaveBeenCalledTimes(1)
  })

  it('shows the create-manager CTA in ready mode', () => {
    const { onCreateManager } = renderCallout({
      mode: 'ready',
      state: {
        status: 'completed',
        completedAt: '2026-03-20T12:00:00.000Z',
        skippedAt: null,
        preferences: {
          preferredName: 'Ada',
          technicalLevel: 'developer',
          additionalPreferences: null,
        },
      },
    })

    const button = getByRole(container, 'button', { name: 'Create your first manager' })
    expect(button).toBeTruthy()
    flushSync(() => {
      button.click()
    })
    expect(onCreateManager).toHaveBeenCalledTimes(1)
  })

  it('prefills values in settings mode', () => {
    renderCallout({
      mode: 'settings',
      state: {
        status: 'completed',
        completedAt: '2026-03-20T12:00:00.000Z',
        skippedAt: null,
        preferences: {
          preferredName: 'Ada',
          technicalLevel: 'technical_non_developer',
          additionalPreferences: 'Prefer plain language.',
        },
      },
    })

    expect(getByDisplayValue(container, 'Ada')).toBeTruthy()
    expect(getByDisplayValue(container, 'Prefer plain language.')).toBeTruthy()
  })
})
