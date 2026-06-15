/** @vitest-environment jsdom */

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileContentResult, FileSaveResponse } from '@forge/protocol'
import type { FileEditorSessionKey } from './use-file-editor-coordinator'
import type { KeyedFileEditorContent } from './use-file-edit-session'

const saveFileContentMock = vi.fn<(_wsUrl: string, _request: unknown) => Promise<FileSaveResponse>>()
const fetchFileContentMock = vi.fn<(_wsUrl: string, _agentId: string, _filePath: string, _worktreeId?: string | null) => Promise<FileContentResult>>()
const applySuccessfulFileSaveToCachesMock = vi.fn<(...args: unknown[]) => unknown>()
const setFileContentCacheMock = vi.fn<(...args: unknown[]) => void>()

vi.mock('./use-file-browser-queries', () => ({
  saveFileContent: (wsUrl: string, request: unknown) => saveFileContentMock(wsUrl, request),
  fetchFileContent: (wsUrl: string, agentId: string, filePath: string, worktreeId?: string | null) =>
    fetchFileContentMock(wsUrl, agentId, filePath, worktreeId),
  applySuccessfulFileSaveToCaches: (...args: unknown[]) => applySuccessfulFileSaveToCachesMock(...args),
  setFileContentCache: (...args: unknown[]) => setFileContentCacheMock(...args),
}))

const { useFileEditSession } = await import('./use-file-edit-session')

type HookResult = ReturnType<typeof useFileEditSession>

const keyA: FileEditorSessionKey = { agentId: 'agent-a', worktreeId: null, filePath: 'a.ts' }
const keyB: FileEditorSessionKey = { agentId: 'agent-a', worktreeId: null, filePath: 'b.ts' }
const versionA = { kind: 'sha256-stat-v1' as const, sha256: 'a', size: 5, mtimeMs: 1 }
const versionB = { kind: 'sha256-stat-v1' as const, sha256: 'b', size: 5, mtimeMs: 2 }

function content(text: string, sha = 'a'): FileContentResult {
  return {
    content: text,
    binary: false,
    size: text.length,
    lines: 1,
    encoding: 'utf8',
    version: { ...versionA, sha256: sha },
    editability: { editable: true, maxEditableBytes: 1024 },
  }
}

let container: HTMLDivElement
let root: Root | null = null
let captured: HookResult | null = null
let currentProps: {
  keyValue: FileEditorSessionKey | null
  keyedContent: KeyedFileEditorContent | null
  onSavedContent?: (saved: KeyedFileEditorContent) => void
}

function TestComponent(props: typeof currentProps) {
  const result = useFileEditSession({
    wsUrl: 'ws://127.0.0.1:47187',
    key: props.keyValue,
    content: props.keyedContent,
    editingEnabled: true,
    onSavedContent: props.onSavedContent,
  })
  useEffect(() => {
    captured = result
  })
  return createElement('div')
}

function renderHook(props: typeof currentProps) {
  currentProps = props
  root = createRoot(container)
  act(() => {
    root?.render(createElement(TestComponent, currentProps))
  })
}

function rerender(props: typeof currentProps) {
  currentProps = props
  act(() => {
    root?.render(createElement(TestComponent, currentProps))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  captured = null
  saveFileContentMock.mockReset()
  fetchFileContentMock.mockReset()
  applySuccessfulFileSaveToCachesMock.mockReset()
  setFileContentCacheMock.mockReset()
  applySuccessfulFileSaveToCachesMock.mockImplementation((options) => {
    const { draftContent, saveResponse } = options as {
      draftContent: string
      saveResponse: Extract<FileSaveResponse, { success: true }>
    }
    return {
      content: { ...content(draftContent, saveResponse.version.sha256), version: saveResponse.version },
      refresh: { content: true, sidebar: true, tree: true, sourceControl: true },
    }
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
    root = null
  }
  container.remove()
})

describe('useFileEditSession', () => {
  it('does not initialize editing from content keyed to a different file', () => {
    renderHook({ keyValue: keyB, keyedContent: { key: keyA, content: content('old') } })

    expect(captured?.canEnterEditMode).toBe(false)
    act(() => captured?.enterEditMode())
    expect(captured?.state.mode).toBe('preview')
  })

  it('preserves conflict draft when save returns a 409-style response', async () => {
    saveFileContentMock.mockResolvedValue({ success: false, conflict: true, reason: 'modified' })
    renderHook({ keyValue: keyA, keyedContent: { key: keyA, content: content('base') } })

    act(() => captured?.enterEditMode())
    act(() => captured?.updateDraft('draft'))
    await act(async () => {
      await captured?.save()
    })

    expect(captured?.state.saveState).toBe('conflict')
    expect(captured?.state.draft).toBe('draft')
    expect(captured?.state.dirty).toBe(true)
  })

  it('ignores stale save results after the active key changes', async () => {
    let resolveSave: (value: FileSaveResponse) => void = () => {}
    saveFileContentMock.mockReturnValue(new Promise<FileSaveResponse>((resolve) => { resolveSave = resolve }))
    const onSavedContent = vi.fn()
    renderHook({ keyValue: keyA, keyedContent: { key: keyA, content: content('base') }, onSavedContent })

    act(() => captured?.enterEditMode())
    act(() => captured?.updateDraft('draft'))
    const savePromise = captured!.save()

    rerender({ keyValue: keyB, keyedContent: { key: keyB, content: { ...content('next'), version: versionB } }, onSavedContent })
    await act(async () => {
      resolveSave({ success: true, version: { ...versionA, sha256: 'saved' }, size: 5, lines: 1, bytesWritten: 5 })
      await savePromise
    })

    expect(onSavedContent).not.toHaveBeenCalled()
    expect(captured?.state.key).toEqual(keyB)
    expect(captured?.state.mode).toBe('preview')
  })

  it('reloads disk content and clears conflict state', async () => {
    fetchFileContentMock.mockResolvedValue(content('disk version', 'disk'))
    saveFileContentMock.mockResolvedValue({ success: false, conflict: true, reason: 'modified' })
    const onSavedContent = vi.fn()
    renderHook({ keyValue: keyA, keyedContent: { key: keyA, content: content('base') }, onSavedContent })

    act(() => captured?.enterEditMode())
    act(() => captured?.updateDraft('draft'))
    await act(async () => {
      await captured?.save()
    })
    expect(captured?.state.saveState).toBe('conflict')

    await act(async () => {
      await captured?.reloadFromDisk()
    })

    expect(fetchFileContentMock).toHaveBeenCalledWith('ws://127.0.0.1:47187', 'agent-a', 'a.ts', null)
    expect(setFileContentCacheMock).toHaveBeenCalled()
    expect(onSavedContent).toHaveBeenCalled()
    expect(captured?.state.draft).toBe('disk version')
    expect(captured?.state.baseContent).toBe('disk version')
    expect(captured?.state.dirty).toBe(false)
    expect(captured?.state.saveState).toBe('idle')
    expect(captured?.state.conflict).toBeNull()
  })

  it('dismisses conflict while preserving the current draft', async () => {
    saveFileContentMock.mockResolvedValue({ success: false, conflict: true, reason: 'modified' })
    renderHook({ keyValue: keyA, keyedContent: { key: keyA, content: content('base') } })

    act(() => captured?.enterEditMode())
    act(() => captured?.updateDraft('draft'))
    await act(async () => {
      await captured?.save()
    })

    act(() => captured?.dismissConflict())

    expect(captured?.state.draft).toBe('draft')
    expect(captured?.state.dirty).toBe(true)
    expect(captured?.state.saveState).toBe('idle')
    expect(captured?.state.conflict).toBeNull()
  })

  it('ignores draft updates while save is in flight', async () => {
    let resolveSave: (value: FileSaveResponse) => void = () => {}
    saveFileContentMock.mockReturnValue(new Promise<FileSaveResponse>((resolve) => { resolveSave = resolve }))
    renderHook({ keyValue: keyA, keyedContent: { key: keyA, content: content('base') } })

    act(() => captured?.enterEditMode())
    act(() => captured?.updateDraft('save-me'))
    let savePromise!: Promise<boolean>
    act(() => {
      savePromise = captured!.save()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(captured?.state.saveState).toBe('saving')

    act(() => captured?.updateDraft('ignored-while-saving'))
    expect(captured?.state.draft).toBe('save-me')
    expect(captured?.state.saveState).toBe('saving')

    await act(async () => {
      resolveSave({
        success: true,
        version: { ...versionA, sha256: 'saved' },
        size: 7,
        lines: 1,
        bytesWritten: 7,
      })
      await savePromise
    })

    expect(captured?.state.draft).toBe('save-me')
    expect(captured?.state.baseContent).toBe('save-me')
    expect(captured?.state.dirty).toBe(false)
    expect(captured?.state.saveState).toBe('saved')
  })

  it('ignores draft updates while reload is in flight', async () => {
    let resolveReload: (value: FileContentResult) => void = () => {}
    fetchFileContentMock.mockReturnValue(new Promise<FileContentResult>((resolve) => { resolveReload = resolve }))
    renderHook({ keyValue: keyA, keyedContent: { key: keyA, content: content('base') } })

    act(() => captured?.enterEditMode())
    act(() => captured?.updateDraft('local draft'))
    let reloadPromise!: Promise<boolean>
    act(() => {
      reloadPromise = captured!.reloadFromDisk()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(captured?.state.saveState).toBe('reloading')

    act(() => captured?.updateDraft('ignored-while-reloading'))
    expect(captured?.state.draft).toBe('local draft')
    expect(captured?.state.saveState).toBe('reloading')

    await act(async () => {
      resolveReload(content('disk version', 'disk'))
      await reloadPromise
    })

    expect(captured?.state.draft).toBe('disk version')
    expect(captured?.state.baseContent).toBe('disk version')
    expect(captured?.state.dirty).toBe(false)
    expect(captured?.state.saveState).toBe('idle')
    expect(setFileContentCacheMock).toHaveBeenCalled()
  })
})
