/** @vitest-environment jsdom */

import { fireEvent, getByDisplayValue, getByRole, queryByText, waitFor } from '@testing-library/dom'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingCallout } from './OnboardingCallout'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  it('validates required fields before saving', () => {
    const { onSave } = renderCallout()
    act(() => fireEvent.submit(container.querySelector('form')!))
    expect(queryByText(container, 'Name is required.')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()

    act(() => {
      fireEvent.input(getByRole(container, 'textbox', { name: 'Name' }), { target: { value: 'Ada' } })
      fireEvent.submit(container.querySelector('form')!)
    })
    expect(queryByText(container, 'Technical level is required.')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('submits trimmed values and null-normalizes blank preferences', async () => {
    const { onSave } = renderCallout()
    act(() => {
      fireEvent.input(getByRole(container, 'textbox', { name: 'Name' }), { target: { value: '  Ada Lovelace  ' } })
      const technicalSelect = container.querySelector('select')!
      fireEvent.change(technicalSelect, { target: { value: 'developer' } })
      fireEvent.input(getByRole(container, 'textbox', { name: 'Additional preferences' }), { target: { value: '   ' } })
      fireEvent.submit(container.querySelector('form')!)
    })

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      preferredName: 'Ada Lovelace',
      technicalLevel: 'developer',
      additionalPreferences: null,
    }))
  })

  it('disables all form actions while busy', () => {
    renderCallout({ isBusy: true })
    expect(getByRole(container, 'textbox', { name: 'Name' })).toHaveProperty('disabled', true)
    expect(getByRole(container, 'combobox', { name: 'Technical Level' }).getAttribute('data-disabled')).not.toBeNull()
    expect(getByRole(container, 'button', { name: 'Save & Continue' })).toHaveProperty('disabled', true)
    expect(getByRole(container, 'button', { name: 'Skip for now' })).toHaveProperty('disabled', true)
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
