/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContentResult } from '@forge/protocol'
import { FileContentViewer } from './FileContentViewer'
import type { FileEditSessionController, FileEditSessionState } from './use-file-edit-session'

const codeMirrorProps: Array<Record<string, unknown>> = []

vi.mock('./CodeMirrorFileEditor', () => ({
  CodeMirrorFileEditor: (props: Record<string, unknown>) => {
    codeMirrorProps.push(props)
    return createElement('div', { 'data-testid': 'codemirror-file-editor' })
  },
}))

vi.mock('./FileContentHeader', () => ({
  FileContentHeader: () => createElement('div', { 'data-testid': 'file-content-header' }),
}))

const content: FileContentResult = {
  content: 'base content',
  binary: false,
  size: 12,
  lines: 1,
  encoding: 'utf8',
  version: { kind: 'sha256-stat-v1', sha256: 'base', size: 12, mtimeMs: 1 },
  editability: { editable: true, maxEditableBytes: 1024 },
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  codeMirrorProps.length = 0
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  document.body.innerHTML = ''
})

function createEditSession(overrides: Partial<FileEditSessionController> = {}): FileEditSessionController {
  return {
    state: {
      key: null,
      mode: 'edit',
      draft: 'draft content',
      baseContent: 'base content',
      baseVersion: content.version ?? null,
      dirty: true,
      focused: false,
      saveState: 'conflict',
      error: null,
      conflict: { success: false, conflict: true, reason: 'modified' },
    },
    canEnterEditMode: true,
    enterEditMode: vi.fn(),
    updateDraft: vi.fn(),
    setFocused: vi.fn(),
    save: vi.fn(async () => true),
    reloadFromDisk: vi.fn(async () => true),
    dismissConflict: vi.fn(),
    revert: vi.fn(),
    discard: vi.fn(),
    getDirtySnapshot: vi.fn(),
    ...overrides,
  }
}

function renderViewer(editSession: FileEditSessionController) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(FileContentViewer, {
      wsUrl: 'ws://127.0.0.1:47187',
      agentId: 'agent-a',
      cwd: '/repo',
      filePath: 'src/example.ts',
      content,
      isLoading: false,
      error: null,
      onNavigateToDirectory: vi.fn(),
      inlineEditingEnabled: true,
      editSession,
    }))
  })
}

function bannerButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .filter((candidate) => !candidate.closest('[role="alertdialog"]'))
    .find((candidate) => candidate.textContent?.includes(label))
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function openReloadConfirmDialog() {
  act(() => {
    bannerButton('Reload from disk').click()
  })
  expect(document.body.textContent).toContain('Reload from disk?')
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="alertdialog"]')
  expect(dialog).not.toBeNull()
  const button = Array.from(dialog!.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(label))
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function editState(overrides: Partial<FileEditSessionState>): FileEditSessionState {
  return {
    key: null,
    mode: 'edit',
    draft: 'draft content',
    baseContent: 'base content',
    baseVersion: content.version ?? null,
    dirty: true,
    focused: false,
    saveState: 'idle',
    error: null,
    conflict: null,
    ...overrides,
  }
}

describe('FileContentViewer conflict recovery', () => {
  it('offers reload, overwrite, and cancel actions in the conflict banner', () => {
    renderViewer(createEditSession())

    expect(container.textContent).toContain('This file changed on disk since you opened it.')
    expect(bannerButton('Reload from disk')).toBeTruthy()
    expect(bannerButton('Overwrite anyway')).toBeTruthy()
    expect(bannerButton('Cancel')).toBeTruthy()
  })

  it('reloads from disk after AlertDialog confirmation', () => {
    const editSession = createEditSession()
    renderViewer(editSession)

    openReloadConfirmDialog()
    expect(editSession.reloadFromDisk).not.toHaveBeenCalled()

    act(() => {
      dialogButton('Discard and reload').click()
    })
    expect(editSession.reloadFromDisk).toHaveBeenCalledTimes(1)
  })

  it('does not reload from disk when AlertDialog confirmation is declined', () => {
    const editSession = createEditSession()
    renderViewer(editSession)

    openReloadConfirmDialog()
    act(() => {
      dialogButton('Cancel').click()
    })

    expect(editSession.reloadFromDisk).not.toHaveBeenCalled()
  })

  it('overwrites on disk when requested', () => {
    const editSession = createEditSession()
    renderViewer(editSession)

    bannerButton('Overwrite anyway').click()

    expect(editSession.save).toHaveBeenCalledWith({ overwrite: true })
  })

  it('dismisses conflict without clearing the draft', () => {
    const editSession = createEditSession()
    renderViewer(editSession)

    bannerButton('Cancel').click()

    expect(editSession.dismissConflict).toHaveBeenCalledTimes(1)
  })

  it('disables conflict actions while save is in flight', () => {
    renderViewer(createEditSession({
      state: editState({
        saveState: 'saving',
        conflict: { success: false, conflict: true, reason: 'modified' },
      }),
    }))

    expect(bannerButton('Reload from disk').disabled).toBe(true)
    expect(bannerButton('Overwrite anyway').disabled).toBe(true)
    expect(bannerButton('Cancel').disabled).toBe(true)
  })

  it('disables conflict actions while reload is in flight', () => {
    renderViewer(createEditSession({
      state: editState({
        saveState: 'reloading',
        conflict: { success: false, conflict: true, reason: 'modified' },
      }),
    }))

    expect(bannerButton('Reloading…').disabled).toBe(true)
    expect(bannerButton('Overwrite anyway').disabled).toBe(true)
    expect(bannerButton('Cancel').disabled).toBe(true)
  })
})

describe('FileContentViewer in-flight editor lock', () => {
  it('locks the editor while save is in flight', () => {
    renderViewer(createEditSession({
      state: editState({ saveState: 'saving' }),
    }))

    expect(codeMirrorProps.at(-1)?.readOnly).toBe(true)
  })

  it('locks the editor while reload is in flight', () => {
    renderViewer(createEditSession({
      state: editState({ saveState: 'reloading' }),
    }))

    expect(codeMirrorProps.at(-1)?.readOnly).toBe(true)
  })

  it('does not trigger save from the editor shortcut while locked', () => {
    const editSession = createEditSession({
      state: editState({ saveState: 'saving' }),
    })
    renderViewer(editSession)

    const onSaveShortcut = codeMirrorProps.at(-1)?.onSaveShortcut as (() => void) | undefined
    expect(onSaveShortcut).toBeTypeOf('function')
    onSaveShortcut?.()

    expect(editSession.save).not.toHaveBeenCalled()
  })
})
