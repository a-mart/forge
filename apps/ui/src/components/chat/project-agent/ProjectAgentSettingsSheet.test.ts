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
  onDemote?: ProjectAgentSettingsSheetProps['onDemote']
  onGetProjectAgentConfig?: ProjectAgentSettingsSheetProps['onGetProjectAgentConfig']
  onGetReference?: ProjectAgentSettingsSheetProps['onGetReference']
  onSetReference?: ProjectAgentSettingsSheetProps['onSetReference']
  onDeleteReference?: ProjectAgentSettingsSheetProps['onDeleteReference']
} = {}) {
  const onSave = overrides.onSave ?? vi.fn(async () => {})
  const onDemote = overrides.onDemote ?? vi.fn(async () => {})
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
        onGetReference: overrides.onGetReference,
        onSetReference: overrides.onSetReference,
        onDeleteReference: overrides.onDeleteReference,
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

  it('renders read-only mode for repo-sourced project agents', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'repo-agent',
        whenToUse: 'Repository defined agent',
        source: {
          type: 'repo',
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'repo-agent',
          whenToUse: 'Repository defined agent',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: 'Repo prompt content',
        references: ['ref.md'],
      })),
    })

    await flushEffects()

    // Repository badge should be visible
    expect(document.body.textContent).toContain('Repository')

    // Source path should be displayed
    expect(document.body.textContent).toContain('/test/repo/.forge')

    // Fields should be disabled/read-only
    const whenToUseField = document.body.querySelector('#whenToUse') as HTMLTextAreaElement
    expect(whenToUseField).not.toBeNull()
    expect(whenToUseField.disabled).toBe(true)

    const systemPromptField = document.body.querySelector('#systemPrompt') as HTMLTextAreaElement
    expect(systemPromptField).not.toBeNull()
    expect(systemPromptField.disabled).toBe(true)

    const capabilitiesToggle = document.body.querySelector('#canCreateSessions') as HTMLButtonElement
    expect(capabilitiesToggle).not.toBeNull()
    expect(capabilitiesToggle.disabled).toBe(true)

    expect(document.body.textContent).toContain('Approved at activation from config.json. Re-activate or link again to change capabilities.')
    expect(document.body.textContent).toContain('Read live from prompt.md in the repo definition directory as role instructions.')
    expect(document.body.textContent).toContain('Forge adds the Project Agent base prompt automatically.')
    expect(document.body.textContent).toContain('Repository reference documents are read from .forge/project-agents/<definitionId>/reference')

    // Save should not be present; repo agents expose a distinct deactivate action.
    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Save',
    )
    expect(saveButton).toBeUndefined()

    const deactivateButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Deactivate repository Project Agent',
    )
    expect(deactivateButton).not.toBeNull()
    expect(document.body.textContent).not.toContain('Add Reference Document')
    expect(document.body.textContent).not.toContain('Delete ref.md')
    expect(document.body.textContent).not.toContain('Save')

    // Close button should be present (not Cancel)
    const closeButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Close',
    )
    expect(closeButton).not.toBeNull()
  })

  it('renders read-only mode for reload-style public repo source marker', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'repo-agent',
        whenToUse: 'Repository defined agent',
        sourceKind: 'repo',
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'repo-agent',
          whenToUse: 'Repository defined agent',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: 'Repo prompt content',
        references: ['ref.md'],
        source: {
          type: 'repo' as const,
          status: 'valid' as const,
          problems: [],
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      })),
    })

    await flushEffects()

    const whenToUseField = document.body.querySelector('#whenToUse') as HTMLTextAreaElement
    expect(whenToUseField).not.toBeNull()
    expect(whenToUseField.disabled).toBe(true)

    const systemPromptField = document.body.querySelector('#systemPrompt') as HTMLTextAreaElement
    expect(systemPromptField).not.toBeNull()
    expect(systemPromptField.disabled).toBe(true)

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Save',
    )
    expect(saveButton).toBeUndefined()

    expect(document.body.textContent).toContain('Deactivate repository Project Agent')
    expect(document.body.textContent).toContain('/test/repo/.forge')
  })

  it('displays source status and problems for unhealthy repo-sourced agents', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'repo-agent',
        whenToUse: 'Stale descriptor description',
        source: {
          type: 'repo',
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'repo-agent',
          whenToUse: 'Live repo description',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: 'Repo prompt',
        references: [],
        source: {
          type: 'repo' as const,
          status: 'missing' as const,
          problems: [
            { code: 'DEFINITION_DIR_NOT_FOUND', message: 'Definition directory does not exist' },
          ],
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      })),
    })

    await flushEffects()

    // Should show warning banner with status
    const banner = document.body.querySelector('[data-testid="source-status-banner"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('missing')

    // Should show problem message
    expect(banner!.textContent).toContain('Definition directory does not exist')

    // Should show definitionId
    expect(banner!.textContent).toContain('def-repo-agent')

    // Should show source path
    expect(banner!.textContent).toContain('/test/repo/.forge')

    const whenToUseField = document.body.querySelector('#whenToUse') as HTMLTextAreaElement
    expect(whenToUseField.value).toBe('')
  })

  it('displays wrong_workspace status with actionable diagnostic', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'ws-agent',
        whenToUse: 'Some description',
        source: {
          type: 'repo',
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/other/repo/.forge',
          definitionId: 'def-ws-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'ws-agent',
          whenToUse: 'Some description',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: null,
        references: [],
        source: {
          type: 'repo' as const,
          status: 'wrong_workspace' as const,
          problems: [],
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/other/repo/.forge',
          definitionId: 'def-ws-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      })),
    })

    await flushEffects()

    const banner = document.body.querySelector('[data-testid="source-status-banner"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('workspace mismatch')
    expect(banner!.textContent).toContain('Switch to the original workspace')
  })

  it('updates whenToUse from live config snapshot for repo-sourced agents', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'repo-agent',
        whenToUse: 'Stale descriptor value',
        source: {
          type: 'repo',
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'repo-agent',
          whenToUse: 'Updated live repo description',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: 'Repo prompt',
        references: [],
        source: {
          type: 'repo' as const,
          status: 'valid' as const,
          problems: [],
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      })),
    })

    await flushEffects()

    // whenToUse field should show the live config value, not the stale descriptor
    const whenToUseField = document.body.querySelector('#whenToUse') as HTMLTextAreaElement
    expect(whenToUseField).not.toBeNull()
    expect(whenToUseField.value).toBe('Updated live repo description')
  })

  it('closes repo-sourced agents without discard prompt when live config differs from descriptor', async () => {
    const { onClose } = renderSheet({
      currentProjectAgent: {
        handle: 'repo-agent',
        whenToUse: 'Stale descriptor value',
        source: {
          type: 'repo',
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'repo-agent',
          whenToUse: 'Updated live repo description',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: 'Repo prompt',
        references: [],
        source: {
          type: 'repo' as const,
          status: 'valid' as const,
          problems: [],
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'def-repo-agent',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      })),
    })

    await flushEffects()

    const closeButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Close',
    )
    expect(closeButton).not.toBeNull()
    flushSync(() => {
      closeButton!.click()
    })

    await flushEffects()

    expect(onClose).toHaveBeenCalled()
    const discardButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Discard',
    )
    expect(discardButton).toBeUndefined()
  })

  it('uses definitionId in repo source path copy, not handle', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'my-handle',
        whenToUse: 'Test agent',
        source: {
          type: 'repo',
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'custom-definition-id',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'my-handle',
          whenToUse: 'Test agent',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: 'Prompt content',
        references: [],
        source: {
          type: 'repo' as const,
          status: 'valid' as const,
          problems: [],
          workspaceKey: 'ws-key',
          forgeDirRealpath: '/test/repo/.forge',
          definitionId: 'custom-definition-id',
          activatedAt: '2026-01-01T00:00:00Z',
        },
      })),
    })

    await flushEffects()

    // Path copy should reference definitionId, not handle
    const text = document.body.textContent ?? ''
    expect(text).toContain('custom-definition-id/prompt.md')
    expect(text).not.toContain('my-handle/prompt.md')
  })

  it('local project agents remain fully editable', async () => {
    renderSheet({
      currentProjectAgent: {
        handle: 'local-agent',
        whenToUse: 'Local agent description',
      },
      onGetProjectAgentConfig: vi.fn(async () => ({
        agentId: 'agent-1',
        config: {
          version: 1,
          agentId: 'agent-1',
          handle: 'local-agent',
          whenToUse: 'Local agent description',
          promotedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        systemPrompt: null,
        references: [],
      })),
    })

    await flushEffects()

    // No Repository badge
    const badges = Array.from(document.body.querySelectorAll('[class*="badge"]'))
    const repoBadge = badges.find((b) => b.textContent?.includes('Repository'))
    expect(repoBadge).toBeUndefined()

    // Fields should be enabled
    const whenToUseField = document.body.querySelector('#whenToUse') as HTMLTextAreaElement
    expect(whenToUseField).not.toBeNull()
    expect(whenToUseField.disabled).toBe(false)

    const systemPromptField = document.body.querySelector('#systemPrompt') as HTMLTextAreaElement
    expect(systemPromptField).not.toBeNull()
    expect(systemPromptField.disabled).toBe(false)
    expect(document.body.textContent).toContain('Role Instructions')
    expect(document.body.textContent).toContain('Use this for role, scope, constraints, and validation habits.')
    expect(document.body.textContent).toContain('Forge layers it after the Project Agent base prompt automatically.')

    // Save and Demote buttons present
    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Save',
    )
    expect(saveButton).toBeTruthy()

    const demoteButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Demote',
    )
    expect(demoteButton).toBeTruthy()

    // Cancel button (not Close)
    const cancelButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Cancel',
    )
    expect(cancelButton).toBeTruthy()
  })
})
