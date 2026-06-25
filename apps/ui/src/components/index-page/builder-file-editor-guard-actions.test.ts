/** @vitest-environment jsdom */

import { createElement, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileEditorCoordinator, type FileEditorGuardApi } from '@/components/file-browser/use-file-editor-coordinator'
import { requestGuardedAgentTransition, requestGuardedArtifactsPanelToggle } from './builder-file-editor-guard-actions'

const dirtyKey = { agentId: 'agent-1', worktreeId: null, filePath: 'src/App.tsx' }

interface Captured {
  dialogOpen: boolean
  saveDialog: () => void
  discardDialog: () => void
  cancelDialog: () => void
  requestArtifactsToggle: (run: () => void) => void
  requestAgentTransition: (nextAgentId: string, run: () => void) => void
}

const captured: { current: Captured | null } = { current: null }

function Harness({ guard }: { guard: FileEditorGuardApi }) {
  const coordinator = useFileEditorCoordinator(guard)

  useLayoutEffect(() => {
    captured.current = {
      dialogOpen: coordinator.dialogState.open,
      saveDialog: coordinator.dialogState.onSave,
      discardDialog: coordinator.dialogState.onDiscard,
      cancelDialog: coordinator.dialogState.onCancel,
      requestArtifactsToggle: (run) => requestGuardedArtifactsPanelToggle(coordinator, run),
      requestAgentTransition: (nextAgentId, run) => requestGuardedAgentTransition(coordinator, nextAgentId, run),
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
  flushSync(() => root?.unmount())
  root = null
  container.remove()
})

function renderHarness(guard: FileEditorGuardApi) {
  flushSync(() => {
    root = createRoot(container)
    root.render(createElement(Harness, { guard }))
  })
}

describe('builder file-editor guarded actions', () => {
  it('opens the chat header artifacts/dashboard toggle without guarding preserved dirty edits', () => {
    const run = vi.fn()
    const discard = vi.fn()
    renderHarness({
      getSnapshot: () => ({ key: dirtyKey, isDirty: true, fileName: 'App.tsx' }),
      save: vi.fn().mockResolvedValue(true),
      discard,
    })

    flushSync(() => {
      captured.current?.requestArtifactsToggle(run)
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(captured.current?.dialogOpen).toBe(false)
    expect(discard).not.toHaveBeenCalled()
  })

  it('guards create/session route transitions until dirty edits are saved', async () => {
    const run = vi.fn()
    const save = vi.fn().mockResolvedValue(true)
    renderHarness({
      getSnapshot: () => ({ key: dirtyKey, isDirty: true, fileName: 'App.tsx' }),
      save,
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestAgentTransition('new-session', run)
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)

    flushSync(() => {
      captured.current?.saveDialog()
    })

    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledTimes(1)
    })
  })

  it('guards external route/fallback agent transitions until dirty edits are discarded', () => {
    const run = vi.fn()
    renderHarness({
      getSnapshot: () => ({ key: dirtyKey, isDirty: true, fileName: 'App.tsx' }),
      save: vi.fn().mockResolvedValue(true),
      discard: vi.fn(),
    })

    flushSync(() => {
      captured.current?.requestAgentTransition('fallback-agent', run)
    })

    expect(run).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)

    flushSync(() => {
      captured.current?.discardDialog()
    })

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('guards active-session delete until save or discard and does not delete on cancel', async () => {
    const deleteSession = vi.fn()
    const save = vi.fn().mockResolvedValue(true)
    const discard = vi.fn()
    renderHarness({
      getSnapshot: () => ({ key: dirtyKey, isDirty: true, fileName: 'App.tsx' }),
      save,
      discard,
    })

    flushSync(() => {
      captured.current?.requestAgentTransition('agent-1', deleteSession)
    })

    expect(deleteSession).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(true)

    flushSync(() => {
      captured.current?.cancelDialog()
    })

    expect(deleteSession).not.toHaveBeenCalled()
    expect(captured.current?.dialogOpen).toBe(false)

    flushSync(() => {
      captured.current?.requestAgentTransition('agent-1', deleteSession)
    })
    flushSync(() => {
      captured.current?.discardDialog()
    })

    expect(discard).toHaveBeenCalledTimes(1)
    expect(deleteSession).toHaveBeenCalledTimes(1)

    flushSync(() => {
      captured.current?.requestAgentTransition('agent-1', deleteSession)
    })
    flushSync(() => {
      captured.current?.saveDialog()
    })

    await vi.waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1)
      expect(deleteSession).toHaveBeenCalledTimes(2)
    })
  })
})
