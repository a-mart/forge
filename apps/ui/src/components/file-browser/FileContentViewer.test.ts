/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContentResult } from '@forge/protocol'
import { FileContentViewer } from './FileContentViewer'
import type { FileEditSessionController, FileEditSessionState } from './use-file-edit-sessions'

const codeMirrorProps: Array<Record<string, unknown>> = []
const headerProps: Array<Record<string, unknown>> = []
const markdownPreviewProps: Array<Record<string, unknown>> = []
const pdfPreviewProps: Array<Record<string, unknown>> = []

vi.mock('./PdfPreview', () => ({
  PdfPreview: (props: Record<string, unknown>) => {
    pdfPreviewProps.push(props)
    return createElement('div', { 'data-testid': 'pdf-preview' })
  },
}))

vi.mock('./CodeMirrorFileEditor', () => ({
  CodeMirrorFileEditor: (props: Record<string, unknown>) => {
    codeMirrorProps.push(props)
    return createElement('div', { 'data-testid': 'codemirror-file-editor' })
  },
}))

vi.mock('./FileContentHeader', () => ({
  FileContentHeader: (props: Record<string, unknown>) => {
    headerProps.push(props)
    return createElement('div', { 'data-testid': 'file-content-header' })
  },
}))

vi.mock('./MarkdownPreview', () => ({
  MarkdownPreview: (props: Record<string, unknown>) => {
    markdownPreviewProps.push(props)
    return createElement('div', { 'data-testid': 'markdown-preview' }, String(props.content ?? ''))
  },
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
  headerProps.length = 0
  markdownPreviewProps.length = 0
  pdfPreviewProps.length = 0
  window.localStorage?.removeItem?.('forge-file-browser-markdown-raw')
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

function renderViewer(editSession: FileEditSessionController, overrides: Partial<Parameters<typeof FileContentViewer>[0]> = {}) {
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
      ...overrides,
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

describe('FileContentViewer direct inline editing', () => {
  it('renders editable text files directly in the editor without requiring an Edit action', () => {
    renderViewer(createEditSession({ state: editState({ mode: 'preview', dirty: false }) }))

    expect(headerProps.at(-1)?.editMode).toBe(true)
    expect(headerProps.at(-1)).not.toHaveProperty('onEnterEditMode')
  })

  it('wires Save and Revert actions while direct editing', () => {
    const editSession = createEditSession({ state: editState({ dirty: true, saveState: 'idle' }) })
    renderViewer(editSession)

    const onSave = headerProps.at(-1)?.onSave as (() => void) | undefined
    const onRevert = headerProps.at(-1)?.onRevert as (() => void) | undefined
    onSave?.()
    onRevert?.()

    expect(editSession.save).toHaveBeenCalledTimes(1)
    expect(editSession.revert).toHaveBeenCalledTimes(1)
  })

  it('keeps mobile/read-only mode on the highlighted preview surface', () => {
    renderViewer(createEditSession(), { inlineEditingEnabled: false })

    expect(codeMirrorProps).toHaveLength(0)
    expect(container.querySelector('.syntax-highlight')).not.toBeNull()
  })

  it('keeps non-editable text files on the highlighted preview surface', () => {
    const readOnlyContent: FileContentResult = {
      ...content,
      editability: { editable: false, reason: 'unsupported_encoding', maxEditableBytes: 1024 },
    }

    renderViewer(createEditSession({ canEnterEditMode: false }), { content: readOnlyContent })

    expect(codeMirrorProps).toHaveLength(0)
    expect(container.querySelector('.syntax-highlight')).not.toBeNull()
  })

  it('passes the active tab editor scroll snapshot through file changes', () => {
    const editSession = createEditSession({ state: editState({ dirty: false }) })
    renderViewer(editSession, {
      filePath: 'src/one.ts',
      contentScrollSnapshot: { kind: 'editor', scrollTop: 140, scrollLeft: 3 },
    })
    expect(codeMirrorProps.at(-1)?.initialScroll).toEqual({ top: 140, left: 3 })

    renderViewer(editSession, {
      filePath: 'src/two.ts',
      contentScrollSnapshot: null,
    })
    expect(codeMirrorProps.at(-1)?.initialScroll).toBeUndefined()
  })
})

describe('FileContentViewer markdown source/preview toggle', () => {
  it('defaults editable markdown files to preview mode with the current draft and toggles to source', () => {
    const editSession = createEditSession({
      state: editState({ mode: 'edit', draft: '# Draft heading', dirty: true }),
    })
    renderViewer(editSession, {
      filePath: 'docs/readme.md',
      content: { ...content, content: '# Base heading', lines: 1 },
    })

    expect(headerProps.at(-1)?.markdownRaw).toBe(false)
    expect(container.querySelector('[data-testid="markdown-preview"]')).not.toBeNull()
    expect(markdownPreviewProps.at(-1)?.content).toBe('# Draft heading')
    expect(codeMirrorProps).toHaveLength(0)

    act(() => {
      const toggle = headerProps.at(-1)?.onToggleMarkdownRaw as (() => void) | undefined
      toggle?.()
    })

    expect(headerProps.at(-1)?.markdownRaw).toBe(true)
    expect(codeMirrorProps.at(-1)?.value).toBe('# Draft heading')
  })

  it('toggles editable markdown from source back to preview mode', () => {
    const editSession = createEditSession({
      state: editState({ mode: 'edit', draft: '# Draft heading', dirty: true }),
    })
    renderViewer(editSession, {
      filePath: 'docs/readme.md',
      content: { ...content, content: '# Base heading', lines: 1 },
    })

    act(() => {
      const toggle = headerProps.at(-1)?.onToggleMarkdownRaw as (() => void) | undefined
      toggle?.()
    })
    expect(headerProps.at(-1)?.markdownRaw).toBe(true)

    act(() => {
      const toggle = headerProps.at(-1)?.onToggleMarkdownRaw as (() => void) | undefined
      toggle?.()
    })

    expect(headerProps.at(-1)?.markdownRaw).toBe(false)
    expect(markdownPreviewProps.at(-1)?.content).toBe('# Draft heading')
  })

  it('preserves a user-selected source view across unrelated re-renders for the same markdown file', () => {
    const editSession = createEditSession({
      state: editState({ mode: 'edit', draft: '# Draft heading', dirty: true }),
    })
    renderViewer(editSession, {
      filePath: 'docs/readme.md',
      content: { ...content, content: '# Base heading', lines: 1 },
    })

    act(() => {
      const toggle = headerProps.at(-1)?.onToggleMarkdownRaw as (() => void) | undefined
      toggle?.()
    })
    expect(headerProps.at(-1)?.markdownRaw).toBe(true)

    renderViewer(editSession, {
      filePath: 'docs/readme.md',
      content: { ...content, content: '# Base heading', lines: 1 },
      contentScrollSnapshot: { kind: 'editor', scrollTop: 12, scrollLeft: 0 },
    })

    expect(headerProps.at(-1)?.markdownRaw).toBe(true)
    expect(codeMirrorProps.at(-1)?.value).toBe('# Draft heading')
  })

  it('defaults back to preview when selecting a different markdown file', () => {
    const editSession = createEditSession({
      state: editState({ mode: 'edit', draft: '# Draft heading', dirty: true }),
    })
    renderViewer(editSession, {
      filePath: 'docs/readme.md',
      content: { ...content, content: '# Base heading', lines: 1 },
    })

    act(() => {
      const toggle = headerProps.at(-1)?.onToggleMarkdownRaw as (() => void) | undefined
      toggle?.()
    })
    expect(headerProps.at(-1)?.markdownRaw).toBe(true)

    renderViewer(editSession, {
      filePath: 'docs/other.md',
      content: { ...content, content: '# Other heading', lines: 1 },
    })

    expect(headerProps.at(-1)?.markdownRaw).toBe(false)
    expect(markdownPreviewProps.at(-1)?.content).toBe('# Draft heading')

    renderViewer(editSession, {
      filePath: 'docs/readme.md',
      content: { ...content, content: '# Base heading', lines: 1 },
    })

    expect(headerProps.at(-1)?.markdownRaw).toBe(false)
  })
})

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

describe('FileContentViewer PDF preview routing', () => {
  it('renders PdfPreview instead of the binary fallback for pdf files', () => {
    root ??= createRoot(container)
    flushSync(() => {
      root?.render(createElement(FileContentViewer, {
        wsUrl: 'ws://127.0.0.1:47187',
        agentId: 'agent-a',
        cwd: '/repo',
        filePath: 'docs/spec.pdf',
        content: {
          content: null,
          binary: true,
          size: 4096,
          editability: { editable: false, reason: 'binary', maxEditableBytes: 1024 },
        },
        isLoading: false,
        error: null,
        onNavigateToDirectory: vi.fn(),
        inlineEditingEnabled: true,
        editSession: createEditSession(),
      }))
    })

    expect(container.querySelector('[data-testid="pdf-preview"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="codemirror-file-editor"]')).toBeNull()
    expect(pdfPreviewProps.at(-1)).toMatchObject({
      sourceUrl: expect.stringContaining('/api/files/raw?'),
      fileName: 'spec.pdf',
      nativeFilePath: '/repo/docs/spec.pdf',
      openUrl: expect.stringContaining('/api/files/raw?'),
    })
  })
})
