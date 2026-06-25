/** @vitest-environment jsdom */

import { createElement, useEffect, useState } from 'react'
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileContentResult } from '@forge/protocol'
import { useFileEditSessions, type FileEditSessionsController } from './use-file-edit-sessions'
import type { FileEditorSessionKey } from './use-file-editor-coordinator'

const key: FileEditorSessionKey = { agentId: 'agent-1', worktreeId: null, filePath: 'src/App.tsx' }

function content(text: string, version = 'v1'): FileContentResult {
  return {
    binary: false,
    content: text,
    encoding: 'utf8',
    size: text.length,
    lines: text.split('\n').length,
    version: { kind: 'sha256-stat-v1', sha256: version, size: text.length, mtimeMs: 1 },
    editability: { editable: true, maxEditableBytes: 1024 },
  }
}

let container: HTMLDivElement
let root: Root | null = null
const captured: { current: FileEditSessionsController | null } = { current: null }

function Harness() {
  const [activeKey] = useState<FileEditorSessionKey | null>(key)
  const sessions = useFileEditSessions({
    wsUrl: 'ws://test',
    activeKey,
    editingEnabled: true,
  })

  useEffect(() => {
    captured.current = sessions
  }, [sessions])

  return createElement('div')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  captured.current = null
  container.remove()
})

describe('useFileEditSessions', () => {
  it('refreshes clean sessions from newly loaded content and version', () => {
    act(() => captured.current!.handleContentLoaded(key, content('one', 'v1')))
    expect(captured.current!.active.state.draft).toBe('one')
    expect(captured.current!.active.state.baseVersion).toMatchObject({ sha256: 'v1' })

    act(() => captured.current!.handleContentLoaded(key, content('two', 'v2')))
    expect(captured.current!.active.state.draft).toBe('two')
    expect(captured.current!.active.state.baseContent).toBe('two')
    expect(captured.current!.active.state.baseVersion).toMatchObject({ sha256: 'v2' })
  })

  it('does not churn controller state when identical content and version are reported repeatedly', () => {
    act(() => captured.current!.handleContentLoaded(key, content('one', 'v1')))
    const controllerAfterFirstLoad = captured.current
    const stateAfterFirstLoad = captured.current!.active.state

    act(() => captured.current!.handleContentLoaded(key, content('one', 'v1')))

    expect(captured.current).toBe(controllerAfterFirstLoad)
    expect(captured.current!.active.state).toBe(stateAfterFirstLoad)
  })

  it('does not overwrite dirty sessions with newly loaded content', () => {
    act(() => captured.current!.handleContentLoaded(key, content('one', 'v1')))
    act(() => captured.current!.active.updateDraft('dirty'))
    act(() => captured.current!.handleContentLoaded(key, content('two', 'v2')))

    expect(captured.current!.active.state.draft).toBe('dirty')
    expect(captured.current!.active.state.baseContent).toBe('one')
    expect(captured.current!.active.state.baseVersion).toMatchObject({ sha256: 'v1' })
  })

  it('keeps preserved discarded sessions editable', () => {
    act(() => captured.current!.handleContentLoaded(key, content('one', 'v1')))
    act(() => captured.current!.active.updateDraft('dirty'))
    act(() => captured.current!.active.discard())

    expect(captured.current!.active.state.draft).toBe('one')
    expect(captured.current!.active.state.dirty).toBe(false)
    expect(captured.current!.active.state.mode).toBe('edit')
    expect(captured.current!.active.canEnterEditMode).toBe(true)
  })

  it('removes sessions affected by successful deletes', () => {
    const nestedKey: FileEditorSessionKey = { ...key, filePath: 'src/nested/File.tsx' }
    act(() => captured.current!.handleContentLoaded(key, content('one', 'v1')))
    act(() => captured.current!.handleContentLoaded(nestedKey, content('nested', 'v1')))

    expect(captured.current!.getSessionKeys().map((sessionKey) => sessionKey.filePath).sort()).toEqual(['src/App.tsx', 'src/nested/File.tsx'])

    act(() => captured.current!.removeSessionsAffectedByDelete({
      agentId: 'agent-1',
      worktreeId: null,
      path: 'src',
      entryType: 'directory',
    }))

    expect(captured.current!.getSessionKeys()).toEqual([])
  })
})
