/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInventoryEntry, SkillShareResponse } from '@forge/protocol'

const apiMock = vi.hoisted(() => ({
  shareSkill: vi.fn(),
}))

vi.mock('./skills-viewer-api', () => ({
  shareSkill: (...args: unknown[]) => apiMock.shareSkill(...args),
}))

const { SkillShareDialog } = await import('./SkillShareDialog')

let container: HTMLDivElement
let root: Root | null = null
let clipboardDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard')
    ?? Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  apiMock.shareSkill.mockResolvedValue(makeShareResponse())
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  } else {
    delete (navigator as Partial<Record<'clipboard', Clipboard>>).clipboard
  }
})

describe('SkillShareDialog', () => {
  it('ignores late share responses after the dialog closes', async () => {
    const pending = deferred<SkillShareResponse>()
    apiMock.shareSkill.mockReturnValueOnce(pending.promise)
    renderDialog({ open: true })

    fireEvent.click(buttonByText('Create share link'))
    await waitFor(() => expect(apiMock.shareSkill).toHaveBeenCalledWith('ws://127.0.0.1:47187', 'skill-1'))

    renderDialog({ open: false })
    pending.resolve(makeShareResponse())
    await flush()

    renderDialog({ open: true })

    expect(document.body.textContent).toContain('Create share link')
    expect(document.body.textContent).not.toContain('Web share link')
    expect(document.body.textContent).not.toContain('https://share.test/s/token')
  })

  it('shows a manual-copy error when clipboard access is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    renderDialog({ open: true })

    fireEvent.click(buttonByText('Create share link'))
    await waitFor(() => expect(document.body.textContent).toContain('Web share link'))

    fireEvent.click(buttonByText('Copy'))

    await waitFor(() => expect(document.body.textContent).toContain('Clipboard access is unavailable. Select and copy the link manually.'))
    expect(document.body.textContent).not.toContain('Copied')
  })
})

function renderDialog({ open }: { open: boolean }): void {
  if (!root) root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SkillShareDialog, {
      open,
      onOpenChange: vi.fn(),
      clientOrWsUrl: 'ws://127.0.0.1:47187',
      skill: makeSkill(),
    }))
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Button not found: ${text}`)
  return button as HTMLButtonElement
}

function makeSkill(): SkillInventoryEntry {
  return {
    skillId: 'skill-1',
    name: 'Shareable Skill',
    directoryName: 'shareable-skill',
    envCount: 0,
    hasRichConfig: false,
    sourceKind: 'machine-local',
    rootPath: '/tmp/skills/shareable-skill',
    skillFilePath: '/tmp/skills/shareable-skill/SKILL.md',
    isInherited: false,
    isEffective: true,
  }
}

function makeShareResponse(): SkillShareResponse {
  return {
    shareUrl: 'https://share.test/s/token',
    importUrl: 'forge://skill-import?url=https%3A%2F%2Fshare.test%2Fs%2Ftoken',
    expiresAt: '2026-05-20T00:00:00.000Z',
    contentSha256: 'a'.repeat(64),
    warnings: [],
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}
