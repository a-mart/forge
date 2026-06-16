import { useCallback, useMemo, useRef, useState } from 'react'

export interface FileEditorSessionKey {
  agentId: string
  worktreeId: string | null
  filePath: string
}

export interface FileEditorDirtySnapshot {
  key: FileEditorSessionKey
  isDirty: boolean
  fileName: string
  isSaving?: boolean
}

export interface FileEditorGuardApi {
  getSnapshot: () => FileEditorDirtySnapshot | null
  save: () => Promise<boolean>
  discard: () => void
}

export type FileEditorTransitionAction =
  | { type: 'select-file'; nextPath: string }
  | { type: 'close-viewer' }
  | { type: 'close-file-browser' }
  | { type: 'open-source-control-inline' }
  | { type: 'source-control-mutation'; mutation: 'switch-branch' | 'create-branch' | 'pull-ff-only'; agentId: string; worktreeId: string | null }
  | { type: 'select-agent'; nextAgentId: string }
  | { type: 'navigate-route'; nextView: 'chat' | 'settings' | 'stats' | 'archive' }
  | { type: 'open-workspace-panel'; panel: 'artifacts' | 'cortex' | 'source-control' | 'chat' }

interface RegisteredGuard {
  key: FileEditorSessionKey
  api: FileEditorGuardApi
  token: symbol
}

interface PendingTransition {
  action: FileEditorTransitionAction
  run: () => void
  snapshot: FileEditorDirtySnapshot
}

export interface FileDirtyConfirmDialogState {
  open: boolean
  snapshot: FileEditorDirtySnapshot | null
  isSaving: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

function serializeFileEditorKey(key: FileEditorSessionKey): string {
  return `${key.agentId}\u0000${key.worktreeId ?? ''}\u0000${key.filePath}`
}

function fileNameFromPath(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath
}

function snapshotsMatchSourceControlMutation(
  snapshot: FileEditorDirtySnapshot,
  action: Extract<FileEditorTransitionAction, { type: 'source-control-mutation' }>,
): boolean {
  return snapshot.key.agentId === action.agentId && snapshot.key.worktreeId === action.worktreeId
}

export function useFileEditorCoordinator(activeGuard?: FileEditorGuardApi | null) {
  const guardsRef = useRef<Map<string, RegisteredGuard>>(new Map())
  const [pendingTransition, setPendingTransition] = useState<PendingTransition | null>(null)
  const [isSavingPendingTransition, setIsSavingPendingTransition] = useState(false)

  const registerWritableEditor = useCallback((key: FileEditorSessionKey, api: FileEditorGuardApi) => {
    const serializedKey = serializeFileEditorKey(key)
    const token = Symbol(serializedKey)
    const existing = guardsRef.current.get(serializedKey)

    if (existing && existing.api !== api && import.meta.env.DEV) {
      console.warn('Duplicate writable file editor registration ignored for', key)
    }

    if (!existing) {
      guardsRef.current.set(serializedKey, { key, api, token })
    }

    return () => {
      const current = guardsRef.current.get(serializedKey)
      if (current?.token === token) {
        guardsRef.current.delete(serializedKey)
      }
    }
  }, [])

  const getDirtySnapshot = useCallback((): FileEditorDirtySnapshot | null => {
    const activeSnapshot = activeGuard?.getSnapshot() ?? null
    if (activeSnapshot?.isDirty) {
      return {
        ...activeSnapshot,
        fileName: activeSnapshot.fileName || fileNameFromPath(activeSnapshot.key.filePath),
      }
    }

    for (const registered of guardsRef.current.values()) {
      const snapshot = registered.api.getSnapshot()
      if (snapshot?.isDirty) {
        return {
          ...snapshot,
          fileName: snapshot.fileName || fileNameFromPath(snapshot.key.filePath),
        }
      }
    }
    return null
  }, [activeGuard])

  const findGuardForSnapshot = useCallback((snapshot: FileEditorDirtySnapshot): FileEditorGuardApi | null => {
    const activeSnapshot = activeGuard?.getSnapshot() ?? null
    if (activeSnapshot && serializeFileEditorKey(activeSnapshot.key) === serializeFileEditorKey(snapshot.key)) {
      return activeGuard ?? null
    }

    return guardsRef.current.get(serializeFileEditorKey(snapshot.key))?.api ?? null
  }, [activeGuard])

  const requestFileEditorTransition = useCallback((action: FileEditorTransitionAction, run: () => void) => {
    const snapshot = getDirtySnapshot()
    if (!snapshot) {
      run()
      return
    }

    if (action.type === 'source-control-mutation' && !snapshotsMatchSourceControlMutation(snapshot, action)) {
      run()
      return
    }

    setPendingTransition({ action, run, snapshot })
  }, [getDirtySnapshot])

  const cancelPendingTransition = useCallback(() => {
    setPendingTransition(null)
    setIsSavingPendingTransition(false)
  }, [])

  const continuePendingTransition = useCallback((transition: PendingTransition) => {
    setPendingTransition(null)
    setIsSavingPendingTransition(false)
    transition.run()
  }, [])

  const saveAndContinue = useCallback(() => {
    const transition = pendingTransition
    if (!transition || isSavingPendingTransition) return

    const guard = findGuardForSnapshot(transition.snapshot)
    if (!guard) {
      continuePendingTransition(transition)
      return
    }

    setIsSavingPendingTransition(true)
    void guard.save()
      .then((saved) => {
        if (saved) {
          continuePendingTransition(transition)
          return
        }
        setPendingTransition(null)
        setIsSavingPendingTransition(false)
      })
      .catch(() => {
        setPendingTransition(null)
        setIsSavingPendingTransition(false)
      })
  }, [continuePendingTransition, findGuardForSnapshot, isSavingPendingTransition, pendingTransition])

  const discardAndContinue = useCallback(() => {
    const transition = pendingTransition
    if (!transition || isSavingPendingTransition) return

    const guard = findGuardForSnapshot(transition.snapshot)
    guard?.discard()
    continuePendingTransition(transition)
  }, [continuePendingTransition, findGuardForSnapshot, isSavingPendingTransition, pendingTransition])

  const dialogState = useMemo<FileDirtyConfirmDialogState>(() => ({
    open: Boolean(pendingTransition),
    snapshot: pendingTransition?.snapshot ?? null,
    isSaving: isSavingPendingTransition || pendingTransition?.snapshot.isSaving === true,
    onSave: saveAndContinue,
    onDiscard: discardAndContinue,
    onCancel: cancelPendingTransition,
  }), [cancelPendingTransition, discardAndContinue, isSavingPendingTransition, pendingTransition, saveAndContinue])

  return {
    registerWritableEditor,
    getDirtySnapshot,
    requestFileEditorTransition,
    dialogState,
  }
}
