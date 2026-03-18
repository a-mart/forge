/** @vitest-environment jsdom */

import { getByRole, getByText, queryByRole } from '@testing-library/dom'
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
  const onSkipForNow = props.onSkipForNow ?? vi.fn()
  const onCreateManager = props.onCreateManager ?? vi.fn()
  const onResumeOnboarding = props.onResumeOnboarding ?? vi.fn()

  flushSync(() => {
    root?.render(
      createElement(OnboardingCallout, {
        status: 'active',
        hasProjectManagers: false,
        onSkipForNow,
        onCreateManager,
        onResumeOnboarding,
        ...props,
      }),
    )
  })

  return {
    onSkipForNow,
    onCreateManager,
    onResumeOnboarding,
  }
}

describe('OnboardingCallout', () => {
  it('fires the skip button action while onboarding is active', () => {
    const { onSkipForNow } = renderCallout()

    const skipButton = getByRole(container, 'button', { name: 'Skip for now' })
    flushSync(() => {
      skipButton.click()
    })

    expect(onSkipForNow).toHaveBeenCalledTimes(1)
  })

  it('shows the post-onboarding create-manager CTA once onboarding is completed', () => {
    renderCallout({ status: 'completed' })

    expect(getByText(container, 'You’re ready to create your first manager.')).toBeTruthy()
    expect(getByRole(container, 'button', { name: 'Create your first manager' })).toBeTruthy()
    expect(queryByRole(container, 'button', { name: 'Skip for now' })).toBeNull()
  })
})
