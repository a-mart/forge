/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillImportPreviewResponse } from '@forge/protocol'

const apiMock = vi.hoisted(() => ({
  previewSkillImportFromUrl: vi.fn(),
  importSkill: vi.fn(),
}))

vi.mock('./skills-viewer-api', () => ({
  previewSkillImportFromUrl: (...args: unknown[]) => apiMock.previewSkillImportFromUrl(...args),
  importSkill: (...args: unknown[]) => apiMock.importSkill(...args),
}))

const { SkillImportDialog } = await import('./SkillImportDialog')

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
  vi.clearAllMocks()
})

describe('SkillImportDialog', () => {
  it('requires re-preview after editing the URL', async () => {
    apiMock.previewSkillImportFromUrl.mockResolvedValue(makePreview('Skill A'))
    renderDialog()
    await flush()

    const input = document.querySelector<HTMLInputElement>('#skill-import-url')!
    fireEvent.change(input, { target: { value: 'https://share.test/s/a' } })
    fireEvent.click(buttonByText('Preview'))

    await waitFor(() => expect(document.body.textContent).toContain('Skill A'))
    flushSync(() => { (document.querySelector('[role="checkbox"]') as HTMLElement).click() })
    await waitFor(() => expect(buttonByText('Import skill').disabled).toBe(false))

    fireEvent.change(input, { target: { value: 'https://share.test/s/b' } })

    expect(document.body.textContent).not.toContain('Skill A')
    expect(buttonByText('Import skill').disabled).toBe(true)
    expect(apiMock.importSkill).not.toHaveBeenCalled()
  })

  it('ignores stale preview responses after a newer URL preview wins', async () => {
    const first = deferred<SkillImportPreviewResponse>()
    apiMock.previewSkillImportFromUrl
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(makePreview('Skill B'))
    renderDialog()
    await flush()

    const input = document.querySelector<HTMLInputElement>('#skill-import-url')!
    fireEvent.change(input, { target: { value: 'https://share.test/s/a' } })
    fireEvent.click(buttonByText('Preview'))
    await waitFor(() => expect(apiMock.previewSkillImportFromUrl).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: 'https://share.test/s/b' } })
    await waitFor(() => expect(buttonByText('Preview').disabled).toBe(false))
    fireEvent.click(buttonByText('Preview'))

    await waitFor(() => expect(apiMock.previewSkillImportFromUrl).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(document.body.textContent).toContain('Skill B'))
    first.resolve(makePreview('Skill A'))

    await flush()
    expect(document.body.textContent).toContain('Skill B')
    expect(document.body.textContent).not.toContain('Skill A')
  })

  it('uses replacement copy for target-directory conflicts', async () => {
    apiMock.previewSkillImportFromUrl.mockResolvedValue(makePreview('Skill A', {
      exists: true,
      existingSourceKind: 'machine-local',
      existingDirectoryName: 'skill-a',
      existingRootPath: '/tmp/skills/skill-a',
      conflictType: 'target_path',
    }))
    renderDialog()
    await flush()

    const input = document.querySelector<HTMLInputElement>('#skill-import-url')!
    fireEvent.change(input, { target: { value: 'https://share.test/s/a' } })
    fireEvent.click(buttonByText('Preview'))

    await waitFor(() => expect(document.body.textContent).toContain('will be replaced if confirmed'))
    expect(document.body.textContent).toContain('replaces the whole existing global skill directory')
    expect(document.body.textContent).not.toContain('inherited skill directory is not modified')
    expect(buttonByText('Replace and import')).toBeTruthy()
  })

  it('uses override copy for inherited effective skill conflicts', async () => {
    apiMock.previewSkillImportFromUrl.mockResolvedValue(makePreview('Inherited Skill', {
      exists: true,
      existingSourceKind: 'repo',
      existingDirectoryName: 'inherited-skill',
      existingRootPath: '/repo/.pi/skills/inherited-skill',
      conflictType: 'effective_skill',
    }))
    apiMock.importSkill.mockResolvedValue({
      bundle: { skill: { handle: 'inherited-skill', name: 'Inherited Skill' }, files: [], totals: { fileCount: 0, byteCount: 0 } },
      target: { scope: 'global' },
      rootPath: '/tmp/skills/inherited-skill',
      replaced: false,
      installedOverride: true,
      warnings: [],
    })
    renderDialog()
    await flush()

    const input = document.querySelector<HTMLInputElement>('#skill-import-url')!
    fireEvent.change(input, { target: { value: 'https://share.test/s/inherited' } })
    fireEvent.click(buttonByText('Preview'))

    await waitFor(() => expect(document.body.textContent).toContain('will install a global override'))
    expect(document.body.textContent).toContain('inherited skill directory is not modified')
    expect(document.body.textContent).toContain('installs a global override that shadows the inherited skill')
    expect(document.body.textContent).not.toContain('replaces the whole existing global skill directory')

    const checkboxes = Array.from(document.querySelectorAll<HTMLElement>('[role="checkbox"]'))
    expect(checkboxes).toHaveLength(2)
    flushSync(() => {
      for (const checkbox of checkboxes) checkbox.click()
    })
    await waitFor(() => expect(buttonByText('Install override').disabled).toBe(false))
    fireEvent.click(buttonByText('Install override'))

    await waitFor(() => expect(apiMock.importSkill).toHaveBeenCalledWith('ws://127.0.0.1:47187', expect.objectContaining({
      source: { url: 'https://share.test/s/inherited' },
      target: { scope: 'global' },
      conflictStrategy: 'replace',
      confirmReplace: true,
    })))
  })
})

function renderDialog(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SkillImportDialog, {
      open: true,
      onOpenChange: vi.fn(),
      clientOrWsUrl: 'ws://127.0.0.1:47187',
      profiles: [],
      initialScope: '__global__',
      onImported: vi.fn(),
    }))
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'))
  const button = buttons.find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Button not found: ${text}`)
  return button as HTMLButtonElement
}

function makePreview(name: string, conflict: SkillImportPreviewResponse['conflict'] = { exists: false }): SkillImportPreviewResponse {
  return {
    bundle: {
      format: 'forge.skill.bundle.v1',
      bundleVersion: 1,
      createdAt: '2026-05-13T00:00:00.000Z',
      contentSha256: 'a'.repeat(64),
      origin: { platform: 'darwin', arch: 'arm64', skillSourceKind: 'machine-local' },
      skill: {
        handle: name.toLowerCase().replaceAll(' ', '-'),
        name,
        env: [],
        frontmatter: { knownForgeKeys: [], knownPiKeys: [], unsupportedKeys: [], warnings: [] },
      },
      portability: { osIndicators: [], scripts: [], dependencies: [] },
      files: [],
      totals: { fileCount: 0, byteCount: 0 },
    },
    target: { scope: 'global' },
    conflict,
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
