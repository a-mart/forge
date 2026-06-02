/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectAgentSharingDialog } from './ProjectAgentSharingDialog'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.scrollIntoView = vi.fn() as Element['scrollIntoView']
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }
  root = null
  container.remove()
  document.body.innerHTML = ''
})

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function renderDialog() {
  const onClose = vi.fn()
  const onGetProjectAgentSharing = vi.fn(async () => ({
    agentId: 'agent-1',
    grants: [],
    eligibleTargets: [
      {
        profileId: 'profile-2',
        displayName: 'Docs Project',
        namespacePreview: 'docs',
        alreadyShared: false,
      },
    ],
  }))
  const onSetProjectAgentSharing = vi.fn(async (_agentId: string, targetProfileIds: string[]) => ({
    agentId: 'agent-1',
    grants: [],
    eligibleTargets: [
      {
        profileId: 'profile-2',
        displayName: 'Docs Project',
        namespacePreview: 'docs',
        alreadyShared: targetProfileIds.includes('profile-2'),
      },
    ],
    addedTargetProfileIds: targetProfileIds,
    removedTargetProfileIds: [],
  }))

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(ProjectAgentSharingDialog, {
      agentId: 'agent-1',
      sessionLabel: 'Research Agent',
      currentProjectAgent: {
        handle: 'research',
        whenToUse: 'Research tasks',
      },
      onClose,
      onGetProjectAgentSharing,
      onSetProjectAgentSharing,
    }))
  })

  return { onClose, onGetProjectAgentSharing, onSetProjectAgentSharing }
}

describe('ProjectAgentSharingDialog', () => {
  it('loads targets and saves selected shares explicitly', async () => {
    const { onClose, onGetProjectAgentSharing, onSetProjectAgentSharing } = renderDialog()
    await flushEffects()

    expect(onGetProjectAgentSharing).toHaveBeenCalledWith('agent-1')
    expect(document.body.textContent).toContain('Share Project Agent')
    expect(document.body.textContent).toContain('Docs Project')
    expect(document.body.textContent).toContain('@docs/research')

    const saveButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    ) as HTMLButtonElement | undefined
    expect(saveButton).toBeDefined()
    expect(saveButton!.disabled).toBe(true)

    const shareSwitch = document.body.querySelector('[aria-label="Share with Docs Project"]') as HTMLElement | null
    expect(shareSwitch).not.toBeNull()
    flushSync(() => {
      shareSwitch!.click()
    })
    await flushEffects()

    expect(saveButton!.disabled).toBe(false)
    flushSync(() => {
      saveButton!.click()
    })
    await flushEffects()

    expect(onSetProjectAgentSharing).toHaveBeenCalledWith('agent-1', ['profile-2'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
