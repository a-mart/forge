/** @vitest-environment jsdom */

import { fireEvent, getByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionModelPickerConfig } from './types'
import type {
  AgentDescriptor,
  ManagerExactModelSelection,
  ManagerProfile,
  ManagerReasoningLevel,
  SessionModelUpdateMode,
} from '@forge/protocol'

interface DialogConfirmProps {
  onConfirm: (
    sessionAgentId: string,
    mode: SessionModelUpdateMode,
    modelSelection?: ManagerExactModelSelection,
    reasoningLevel?: ManagerReasoningLevel,
  ) => void
}

vi.mock('../agent-sidebar/dialogs/SessionModelDialog', () => ({
  SessionModelDialog: ({ onConfirm }: DialogConfirmProps) => createElement(
    'div',
    { role: 'dialog' },
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => onConfirm(
          'manager-1',
          'override',
          { provider: 'anthropic', modelId: 'claude-opus-4-6' },
          'high',
        ),
      },
      'Apply override',
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => onConfirm('manager-1', 'inherit'),
      },
      'Use project default',
    ),
  ),
}))

const { SessionModelPicker } = await import('./SessionModelPicker')
const { isSessionModelPickerEligible } = await import('./session-model-picker-eligibility')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

const pickerApiClient = { target: { kind: 'builder' } } as unknown as SettingsApiClient

function makeConfig(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
): SessionModelPickerConfig {
  return {
    originId: 'local',
    httpClientRef: { current: pickerApiClient },
    sessionAgentId: 'manager-1',
    sessionLabel: 'Main',
    currentModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'xhigh',
    },
    modelOrigin: 'profile_default',
    profileDefaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'xhigh',
    },
    onUpdate,
    ...overrides,
  }
}

function renderPicker(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
) {
  root = createRoot(container)
  rerenderPicker(onUpdate, overrides)
}

function rerenderPicker(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
) {
  flushSync(() => {
    root?.render(createElement(SessionModelPicker, {
      config: makeConfig(onUpdate, overrides),
    }))
  })
}

describe('isSessionModelPickerEligible', () => {
  const manager = {
    role: 'manager',
    profileId: 'profile-1',
    sessionSurface: 'builder',
  } as AgentDescriptor
  const profile = {
    profileId: 'profile-1',
    profileType: 'user',
  } as ManagerProfile

  it('allows only matching user-profile Builder managers', () => {
    expect(isSessionModelPickerEligible(manager, profile)).toBe(true)
    expect(isSessionModelPickerEligible({ ...manager, role: 'worker' }, profile)).toBe(false)
    expect(isSessionModelPickerEligible({ ...manager, sessionSurface: 'collab' }, profile)).toBe(false)
    expect(isSessionModelPickerEligible(manager, { ...profile, profileType: 'system' })).toBe(false)
    expect(isSessionModelPickerEligible(manager, { ...profile, profileId: 'other-profile' })).toBe(false)
    expect(isSessionModelPickerEligible(manager, null)).toBe(false)
  })
})

describe('SessionModelPicker update bridge', () => {
  it('forwards exact override selections and closes the dialog', () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: /change session model/i }))
    })
    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Apply override' }))
    })

    expect(onUpdate).toHaveBeenCalledWith(
      'manager-1',
      'override',
      { provider: 'anthropic', modelId: 'claude-opus-4-6' },
      'high',
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each([
    ['session', { sessionAgentId: 'manager-2' }],
    ['origin with an equal agent id', { originId: 'remote-2' }],
  ])('closes an open dialog when the active %s changes', async (_scope, overrides) => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: /change session model/i }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()

    rerenderPicker(onUpdate, overrides)
    await act(async () => {})

    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('forwards inheritance without stale override fields', () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)

    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: /change session model/i }))
    })
    flushSync(() => {
      fireEvent.click(getByRole(container, 'button', { name: 'Use project default' }))
    })

    expect(onUpdate).toHaveBeenCalledWith('manager-1', 'inherit')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
