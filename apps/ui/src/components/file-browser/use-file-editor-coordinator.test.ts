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

function Harness({
  activeGuard,
  hiddenDirtySnapshots,
  hiddenGuard,
}: {
  activeGuard: FileEditorGuardApi | null
  hiddenDirtySnapshots?: FileEditorDirtySnapshot[]
  hiddenGuard?: FileEditorGuardApi | null
}) {
  const coordinator = useFileEditorCoordinator(activeGuard, {
    getDirtySnapshots: hiddenDirtySnapshots ? () => hiddenDirtySnapshots : undefined,
    getGuardForKey: hiddenGuard ? () => hiddenGuard : undefined,
  })

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

function renderHarness(
  activeGuard: FileEditorGuardApi | null,
  options: { hiddenDirtySnapshots?: FileEditorDirtySnapshot[]; hiddenGuard?: FileEditorGuardApi | null } = {},
) {
  flushSync(() => {
    root = createRoot(container)
    root.render(createElement(Harness, { activeGuard, ...options }))
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

  it('does not guard file switch transitions because tab state preserves drafts', () => {
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save: vi.fn(),
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'select-file', nextPath: 'src/Other.tsx' }, run)
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
  })

  it('guards dirty tab close transitions until discard or save succeeds', async () => {
    const save = vi.fn().mockResolvedValue(true)
    const discard = vi.fn()
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save,
      discard,
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'close-tab', key: workspaceKey }, run)
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
      captured.current?.requestFileEditorTransition({ type: 'delete-entry', path: 'src', entryType: 'directory', agentId: 'agent-1', worktreeId: null }, run, onCancel)
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
      captured.current?.requestFileEditorTransition({ type: 'close-tab', key: workspaceKey }, run, onCancel)
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
          { type: 'delete-entry', path: 'src', entryType: 'directory', agentId: 'agent-1', worktreeId: null },
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
      captured.current?.requestFileEditorTransition({ type: 'delete-entry', path: 'src', entryType: 'directory', agentId: 'agent-1', worktreeId: null }, run, onCancel)
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

  it('does not guard opening Source Control because dirty drafts are preserved', () => {
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => dirtySnapshot(workspaceKey),
      save: vi.fn(),
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition({ type: 'open-source-control-inline' }, run)
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
  })

  it('guards delete transitions for every matching dirty file before running', () => {
    const firstKey = { ...workspaceKey, filePath: 'src/A.tsx' }
    const secondKey = { ...workspaceKey, filePath: 'src/nested/B.tsx' }
    const firstDiscard = vi.fn()
    const secondDiscard = vi.fn()
    const run = vi.fn()
    renderHarness(null)

    flushSync(() => {
      captured.current?.registerWritableEditor(firstKey, {
        getSnapshot: () => dirtySnapshot(firstKey),
        save: vi.fn().mockResolvedValue(true),
        discard: firstDiscard,
      })
      captured.current?.registerWritableEditor(secondKey, {
        getSnapshot: () => dirtySnapshot(secondKey),
        save: vi.fn().mockResolvedValue(true),
        discard: secondDiscard,
      })
      captured.current?.requestFileEditorTransition({ type: 'delete-entry', path: 'src', entryType: 'directory', agentId: 'agent-1', worktreeId: null }, run)
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogSnapshot?.key).toEqual(firstKey)

    flushSync(() => captured.current?.discard())
    expect(firstDiscard).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)
    expect(captured.current?.dialogSnapshot?.key).toEqual(secondKey)

    flushSync(() => captured.current?.discard())
    expect(secondDiscard).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
  })

  it('guards delete transitions only for dirty files in the requested scope', () => {
    const otherScopeKey = { agentId: 'agent-2', worktreeId: 'other-worktree', filePath: 'src/App.tsx' }
    const matchingDiscard = vi.fn()
    const otherDiscard = vi.fn()
    const run = vi.fn()
    renderHarness(null)

    flushSync(() => {
      captured.current?.registerWritableEditor(otherScopeKey, {
        getSnapshot: () => dirtySnapshot(otherScopeKey),
        save: vi.fn().mockResolvedValue(true),
        discard: otherDiscard,
      })
      captured.current?.registerWritableEditor(linkedWorktreeKey, {
        getSnapshot: () => dirtySnapshot(linkedWorktreeKey),
        save: vi.fn().mockResolvedValue(true),
        discard: matchingDiscard,
      })
      captured.current?.requestFileEditorTransition(
        { type: 'delete-entry', path: 'src/App.tsx', entryType: 'file', agentId: 'agent-1', worktreeId: 'linked-1' },
        run,
      )
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogSnapshot?.key).toEqual(linkedWorktreeKey)

    flushSync(() => captured.current?.discard())
    expect(matchingDiscard).toHaveBeenCalledTimes(1)
    expect(otherDiscard).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
  })

  it('guards Source Control mutations for every dirty tab in the same worktree before running', async () => {
    const firstKey = { ...linkedWorktreeKey, filePath: 'src/A.tsx' }
    const secondKey = { ...linkedWorktreeKey, filePath: 'src/B.tsx' }
    const firstSave = vi.fn().mockResolvedValue(true)
    const secondSave = vi.fn().mockResolvedValue(true)
    const run = vi.fn()
    renderHarness(null)

    flushSync(() => {
      captured.current?.registerWritableEditor(firstKey, {
        getSnapshot: () => dirtySnapshot(firstKey),
        save: firstSave,
        discard: vi.fn(),
      })
      captured.current?.registerWritableEditor(secondKey, {
        getSnapshot: () => dirtySnapshot(secondKey),
        save: secondSave,
        discard: vi.fn(),
      })
      captured.current?.requestFileEditorTransition(
        { type: 'source-control-mutation', mutation: 'switch-branch', agentId: 'agent-1', worktreeId: 'linked-1' },
        run,
      )
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogSnapshot?.key).toEqual(firstKey)

    flushSync(() => captured.current?.save())
    await vi.waitFor(() => expect(firstSave).toHaveBeenCalledTimes(1))
    expect(run).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(captured.current?.dialogSnapshot?.key).toEqual(secondKey))

    flushSync(() => captured.current?.save())
    await vi.waitFor(() => expect(secondSave).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(captured.current?.dialogOpen).toBe(false))
  })

  it('guards Source Control mutations for hidden dirty sessions in the same worktree', () => {
    const run = vi.fn()
    const save = vi.fn().mockResolvedValue(true)
    renderHarness(null, {
      hiddenDirtySnapshots: [dirtySnapshot(linkedWorktreeKey)],
      hiddenGuard: {
        getSnapshot: () => dirtySnapshot(linkedWorktreeKey),
        save,
        discard: vi.fn(),
      },
    })

    flushSync(() => {
      captured.current?.requestFileEditorTransition(
        { type: 'source-control-mutation', mutation: 'switch-branch', agentId: 'agent-1', worktreeId: 'linked-1' },
        run,
      )
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)
    expect(captured.current?.dialogSnapshot?.key).toEqual(linkedWorktreeKey)
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

    const pushRun = vi.fn()
    flushSync(() => {
      captured.current?.requestFileEditorTransition(
        { type: 'source-control-mutation', mutation: 'push', agentId: 'agent-1', worktreeId: 'linked-1' },
        pushRun,
      )
    })
    expect(pushRun).toHaveBeenCalledTimes(1)
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
