/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAgentInfo } from '@forge/protocol'
import { ProjectAgentSettingsSheet } from './ProjectAgentSettingsSheet'

let container: HTMLDivElement
let root: Root | null = null

type ProjectAgentSettingsSheetProps = Parameters<typeof ProjectAgentSettingsSheet>[0]

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

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function renderSheet(overrides: {
  currentProjectAgent?: ProjectAgentInfo | null
  onSave?: ProjectAgentSettingsSheetProps['onSave']
  onGetProjectAgentConfig?: ProjectAgentSettingsSheetProps['onGetProjectAgentConfig']
} = {}) {
  const onSave = overrides.onSave ?? vi.fn(async () => {})
  const onDemote = vi.fn(async () => {})
  const onClose = vi.fn()

  const currentProjectAgent: ProjectAgentInfo | null = overrides.currentProjectAgent !== undefined
    ? overrides.currentProjectAgent
    : {
        handle: 'test-agent',
        whenToUse: 'For testing purposes',
      }

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(ProjectAgentSettingsSheet, {
        agentId: 'agent-1',
        sessionLabel: 'Test Session',
        currentProjectAgent,
        onSave,
        onDemote,
        onClose,
        onGetProjectAgentConfig: overrides.onGetProjectAgentConfig ?? vi.fn(async () => ({
          agentId: 'agent-1',
          config: {
            version: 1,
            agentId: 'agent-1',
            handle: 'test-agent',
            whenToUse: 'For testing purposes',
            promotedAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          systemPrompt: null,
          references: [],
        })),
      }),
    )
  })

  return { onSave, onDemote, onClose }
}

describe('ProjectAgentSettingsSheet', () => {
  it('shows discard confirmation when closing with dirty state in promotion mode', async () => {
    const { onClose } = renderSheet({ currentProjectAgent: null })
    await flushEffects()

    // Type into "when to use" field to make it dirty
    const whenToUseField = document.body.querySelector('#whenToUse') as HTMLTextAreaElement
    expect(whenToUseField).not.toBeNull()
    flushSync(() => {
      // Simulate typing
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      nativeInputValueSetter?.call(whenToUseField, 'Some description')
      whenToUseField.dispatchEvent(new Event('input', { bubbles: true }))
      whenToUseField.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await flushEffects()

    // Click the Cancel button to request close
    const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Cancel',
    )
    expect(cancelButton).not.toBeNull()
    flushSync(() => {
      cancelButton!.click()
    })

    await flushEffects()

    // Discard dialog should be visible
    const discardButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Discard',
    )
    expect(discardButton).not.toBeNull()

    // onClose should NOT have been called yet
    expect(onClose).not.toHaveBeenCalled()

    // Click Discard to confirm
    flushSync(() => {
      discardButton!.click()
    })

    await flushEffects()

    expect(onClose).toHaveBeenCalled()
  })

  it('closes immediately when clean (no dirty state) in settings mode', async () => {
    const { onClose } = renderSheet()
    await flushEffects()

    const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Cancel',
    )
    expect(cancelButton).not.toBeNull()
    flushSync(() => {
      cancelButton!.click()
    })

    await flushEffects()

    // Should close immediately without discard dialog
    expect(onClose).toHaveBeenCalled()
    const discardButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Discard',
    )
    expect(discardButton).toBeUndefined()
  })

  it('renders resize handle on the sheet', async () => {
    renderSheet()
    await flushEffects()

    const resizeHandle = document.body.querySelector('[role="separator"][aria-label="Resize panel"]')
    expect(resizeHandle).not.toBeNull()
  })

  it('renders capability toggle reflecting initial state with create_session', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'test-agent',
        whenToUse: 'For testing purposes',
        capabilities: ['create_session'],
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'test-agent',
          whenToUse: 'For testing purposes',
          capabilities: ['create_session'] as ('create_session')[],
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: null,
        references: [],
      })),
    })

    await flushEffects()

    // Sheet renders in a portal on document.body
    const toggle = document.body.querySelector('#canCreateSessions') as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('data-state')).toBe('checked')
  })

  it('includes capabilities in save payload when toggle is flipped', async () => {
    const onSave = vi.fn(async () => {})
    renderSheet({
      currentProjectAgent: {
        handle: 'test-agent',
        whenToUse: 'For testing purposes',
      },
      onSave,
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'test-agent',
          whenToUse: 'For testing purposes',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: null,
        references: [],
      })),
    })

    await flushEffects()

    // Sheet renders in a portal on document.body
    const toggle = document.body.querySelector('#canCreateSessions') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('data-state')).toBe('unchecked')
    flushSync(() => {
      toggle.click()
    })
    expect(toggle.getAttribute('data-state')).toBe('checked')

    // Click save
    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Save',
    )
    expect(saveButton).not.toBeNull()
    flushSync(() => {
      saveButton!.click()
    })

    await flushEffects()

    expect(onSave).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      capabilities: ['create_session'],
    }))
  })
})
