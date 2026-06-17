/** @vitest-environment jsdom */

import { createElement, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useFileEditorCoordinator,
  type FileEditorDirtySnapshot,
  type FileEditorGuardApi,
  type FileEditorSessionKey,
  type FileEditorTransitionAction,
} from './use-file-editor-coordinator'

const workspaceKey: FileEditorSessionKey = {
  agentId: 'agent-1',
  worktreeId: null,
  filePath: 'src/App.tsx',
}

const linkedWorktreeKey: FileEditorSessionKey = {
  agentId: 'agent-1',
  worktreeId: 'linked-1',
  filePath: 'src/App.tsx',
}

function dirtySnapshot(key: FileEditorSessionKey): FileEditorDirtySnapshot {
  return {
    key,
    isDirty: true,
    fileName: key.filePath.split('/').pop() ?? key.filePath,
  }
}

function cleanSnapshot(key: FileEditorSessionKey): FileEditorDirtySnapshot {
  return {
    key,
    isDirty: false,
    fileName: key.filePath.split('/').pop() ?? key.filePath,
  }
}

interface CapturedCoordinator {
  requestFileEditorTransition: (action: FileEditorTransitionAction, run: () => void, onCancel?: () => void) => void
  dialogOpen: boolean
  dialogSnapshot: FileEditorDirtySnapshot | null
  save: () => void
  discard: () => void
  cancel: () => void
  registerWritableEditor: ReturnType<typeof useFileEditorCoordinator>['registerWritableEditor']
}

const captured: { current: CapturedCoordinator | null } = { current: null }

function Harness({ activeGuard }: { activeGuard: FileEditorGuardApi | null }) {
  const coordinator = useFileEditorCoordinator(activeGuard)

  useLayoutEffect(() => {
    captured.current = {
      requestFileEditorTransition: coordinator.requestFileEditorTransition,
      dialogOpen: coordinator.dialogState.open,
      dialogSnapshot: coordinator.dialogState.snapshot,
      save: coordinator.dialogState.onSave,
      discard: coordinator.dialogState.onDiscard,
      cancel: coordinator.dialogState.onCancel,
      registerWritableEditor: coordinator.registerWritableEditor,
    }
  }, [coordinator])

  return createElement('div')
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  captured.current = null
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
  captured.current = null
})

function renderHarness(activeGuard: FileEditorGuardApi | null) {
  flushSync(() => {
    root = createRoot(container)
    root.render(createElement(Harness, { activeGuard }))
  })
}

describe('useFileEditorCoordinator', () => {
  it('runs clean transitions immediately without opening the dirty dialog', () => {
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => cleanSnapshot(workspaceKey),
      save: vi.fn(),
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'select-file', nextPath: 'src/Other.tsx' }, run)
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
  })

  it('guards file switch and close transitions until discard or save succeeds', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const discard = vi.fn()
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save,
      discard,
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'select-file', nextPath: 'src/Other.tsx' }, run)
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)
    expect(captured.current?.dialogSnapshot?.key).toEqual(workspaceKey)

    flushSync(() => {
      captured.current?.discard()
    })

    expect(discard).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)

    const saveRun = vi.fn()
    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'close-viewer' }, saveRun)
    })
    flushSync(() => {
      captured.current?.save()
    })

    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
      expect(saveRun).toHaveBeenCalledTimes(1)
    })
  })

  it('calls the optional cancel callback when a guarded transition is canceled', () => {
    const run = vi.fn()
    const onCancel = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save: vi.fn(),
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'delete-entry', path: 'src', entryType: 'directory' }, run, onCancel)
    })
    flushSync(() => {
      captured.current?.cancel()
    })

    expect(run).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
  })

  it('clears pending transitions and calls abort callback when save reports conflict', async () => {
    const save = vi.fn().mockResolvedValue(false)
    const run = vi.fn()
    const onCancel = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save,
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'close-file-browser' }, run, onCancel)
    })
    flushSync(() => {
      captured.current?.save()
    })

    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
    })
    expect(run).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(captured.current?.dialogOpen).toBe(false)
    })
  })

  it('settles a guarded delete transition as false when save reports conflict', async () => {
    const save = vi.fn().mockResolvedValue(false)
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save,
      discard: vi.fn(),
    })

    const deleteSettled = new Promise<boolean>((resolve) => {
      flushSync(() => {
        captured.current?.requestFileEditorTransition(
          { type: 'delete-entry', path: 'src', entryType: 'directory' },
          run,
          () => resolve(false),
        )
      })
    })

    flushSync(() => {
      captured.current?.save()
    })

    await expect(deleteSettled).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(captured.current?.dialogOpen).toBe(false)
    })
  })

  it('clears pending transitions and calls abort callback when save rejects', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Save failed'))
    const run = vi.fn()
    const onCancel = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save,
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'delete-entry', path: 'src', entryType: 'directory' }, run, onCancel)
    })
    flushSync(() => {
      captured.current?.save()
    })

    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
    })
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(captured.current?.dialogOpen).toBe(false)
    })
  })

  it('guards Source Control mutations only for the same workspace or linked worktree', () => {
    const sameWorkspaceRun = vi.fn()
    const linkedRun = vi.fn()
    const differentWorktreeRun = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save: vi.fn(),
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition(
        { type: 'source-control-mutation', mutation: 'switch-branch', agentId: 'agent-1', worktreeId: null },
        sameWorkspaceRun,
      )
    })
    expect(sameWorkspaceRun).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)

    flushSync(() => {
      captured.current?.cancel()
    })
    flushSync(() => {
      captured.current?.requestFileEditorTransition(
        { type: 'source-control-mutation', mutation: 'pull-ff-only', agentId: 'agent-1', worktreeId: 'linked-1' },
        differentWorktreeRun,
      )
    })
    expect(differentWorktreeRun).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)

    flushSync(() => {
      root?.render(createElement(Harness, {
        activeGuard: {
          getSnapshot: () => dirtySnapshot(linkedWorktreeKey),
          save: vi.fn(),
          discard: vi.fn(),
        },
      }))
    })
    flushSync(() => {
      captured.current?.requestFileEditorTransition(
        { type: 'source-control-mutation', mutation: 'create-branch', agentId: 'agent-1', worktreeId: 'linked-1' },
        linkedRun,
      )
    })
    expect(linkedRun).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)
  })

  it('ignores duplicate writable registrations for the same key and preserves the first guard', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const firstRun = vi.fn()
    const firstGuard: FileEditorGuardApi = {
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save: vi.fn().mockResolvedValue(true),
      discard: vi.fn(),
    }
    const duplicateGuard: FileEditorGuardApi = {
      getSnapshot: () => dirtySnapshot({ ...workspaceKey, filePath: 'src/Duplicate.tsx' }),
      save: vi.fn().mockResolvedValue(true),
      discard: vi.fn(),
    }
    renderHarness(null)

    flushSync(() => {
      captured.current?.registerWritableEditor(workspaceKey, firstGuard)
      captured.current?.registerWritableEditor(workspaceKey, duplicateGuard)
      captured.current?.requestFileEditorTransition({ type: 'close-viewer' }, firstRun)
    })

    expect(firstRun).not.toHaveBeenCalled()
    expect(captured.current?.dialogSnapshot?.fileName).toBe('App.tsx')
    warnSpy.mockRestore()
  })
})
