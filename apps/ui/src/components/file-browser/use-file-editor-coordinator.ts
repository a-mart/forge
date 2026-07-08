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
  | { type: 'delete-entry'; path: string; entryType: 'file' | 'directory'; agentId: string; worktreeId: string | null }
  | { type: 'rename-entry'; path: string; entryType: 'file' | 'directory'; agentId: string; worktreeId: string | null }
  | { type: 'select-file'; nextPath: string }
  | { type: 'close-viewer' }
  | { type: 'close-tab'; key: FileEditorSessionKey }
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
  snapshots: FileEditorDirtySnapshot[]
  currentIndex: number
  onCancel?: () => void
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

function doesEntryMutationAffectSnapshot(
  snapshot: FileEditorDirtySnapshot,
  action: Extract<FileEditorTransitionAction, { type: 'delete-entry' | 'rename-entry' }>,
): boolean {
  if (snapshot.key.agentId !== action.agentId || (snapshot.key.worktreeId ?? null) !== (action.worktreeId ?? null)) return false

  const deletePath = action.path.replace(/^\/+|\/+$/g, '')
  const filePath = snapshot.key.filePath.replace(/^\/+|\/+$/g, '')
  if (!deletePath) return false
  if (action.entryType === 'file') return filePath === deletePath
  return filePath === deletePath || filePath.startsWith(`${deletePath}/`)
}

function keysEqual(a: FileEditorSessionKey, b: FileEditorSessionKey): boolean {
  return a.agentId === b.agentId && a.worktreeId === b.worktreeId && a.filePath === b.filePath
}

function actionPreservesDirtyDrafts(action: FileEditorTransitionAction): boolean {
  return action.type === 'select-file' ||
    action.type === 'open-workspace-panel' ||
    action.type === 'close-file-browser' ||
    action.type === 'open-source-control-inline'
}

export interface FileEditorCoordinatorOptions {
  getDirtySnapshots?: () => FileEditorDirtySnapshot[]
  getGuardForKey?: (key: FileEditorSessionKey) => FileEditorGuardApi | null
}

const DEFAULT_COORDINATOR_OPTIONS: FileEditorCoordinatorOptions = {}

export function useFileEditorCoordinator(
  activeGuard?: FileEditorGuardApi | null,
  options: FileEditorCoordinatorOptions = DEFAULT_COORDINATOR_OPTIONS,
) {
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

  const getDirtySnapshots = useCallback((): FileEditorDirtySnapshot[] => {
    const snapshots: FileEditorDirtySnapshot[] = []
    const addSnapshot = (snapshot: FileEditorDirtySnapshot | null | undefined) => {
      if (!snapshot?.isDirty) return
      const serialized = serializeFileEditorKey(snapshot.key)
      if (snapshots.some((existing) => serializeFileEditorKey(existing.key) === serialized)) return
      snapshots.push({
        ...snapshot,
        fileName: snapshot.fileName || fileNameFromPath(snapshot.key.filePath),
      })
    }

    addSnapshot(activeGuard?.getSnapshot() ?? null)
    for (const registered of guardsRef.current.values()) {
      addSnapshot(registered.api.getSnapshot())
    }
    for (const snapshot of options.getDirtySnapshots?.() ?? []) {
      addSnapshot(snapshot)
    }
    return snapshots
  }, [activeGuard, options])

  const getDirtySnapshot = useCallback((): FileEditorDirtySnapshot | null => {
    return getDirtySnapshots()[0] ?? null
  }, [getDirtySnapshots])

  const findGuardForSnapshot = useCallback((snapshot: FileEditorDirtySnapshot): FileEditorGuardApi | null => {
    const activeSnapshot = activeGuard?.getSnapshot() ?? null
    if (activeSnapshot && serializeFileEditorKey(activeSnapshot.key) === serializeFileEditorKey(snapshot.key)) {
      return activeGuard ?? null
    }

    return guardsRef.current.get(serializeFileEditorKey(snapshot.key))?.api ?? options.getGuardForKey?.(snapshot.key) ?? null
  }, [activeGuard, options])

  const requestFileEditorTransition = useCallback((
    action: FileEditorTransitionAction,
    run: () => void,
    onCancel?: () => void,
  ) => {
    if (actionPreservesDirtyDrafts(action)) {
      run()
      return
    }

    const snapshots = getDirtySnapshots().filter((candidate) => {
      if (action.type === 'source-control-mutation') return snapshotsMatchSourceControlMutation(candidate, action)
      if (action.type === 'delete-entry' || action.type === 'rename-entry') return doesEntryMutationAffectSnapshot(candidate, action)
      if (action.type === 'close-tab') return keysEqual(candidate.key, action.key)
      return true
    })

    if (snapshots.length === 0) {
      run()
      return
    }

    setPendingTransition({ action, run, snapshots, currentIndex: 0, onCancel })
  }, [getDirtySnapshots])

  const abortPendingTransition = useCallback((transition: PendingTransition | null) => {
    transition?.onCancel?.()
    setPendingTransition(null)
    setIsSavingPendingTransition(false)
  }, [])

  const cancelPendingTransition = useCallback(() => {
    abortPendingTransition(pendingTransition)
  }, [abortPendingTransition, pendingTransition])

  const continuePendingTransition = useCallback((transition: PendingTransition) => {
    const nextIndex = transition.currentIndex + 1
    if (nextIndex < transition.snapshots.length) {
      setPendingTransition({ ...transition, currentIndex: nextIndex })
      setIsSavingPendingTransition(false)
      return
    }

    setPendingTransition(null)
    setIsSavingPendingTransition(false)
    transition.run()
  }, [])

  const saveAndContinue = useCallback(() => {
    const transition = pendingTransition
    if (!transition || isSavingPendingTransition) return

    const snapshot = transition.snapshots[transition.currentIndex]
    const guard = snapshot ? findGuardForSnapshot(snapshot) : null
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
        abortPendingTransition(transition)
      })
      .catch(() => {
        abortPendingTransition(transition)
      })
  }, [abortPendingTransition, continuePendingTransition, findGuardForSnapshot, isSavingPendingTransition, pendingTransition])

  const discardAndContinue = useCallback(() => {
    const transition = pendingTransition
    if (!transition || isSavingPendingTransition) return

    const snapshot = transition.snapshots[transition.currentIndex]
    const guard = snapshot ? findGuardForSnapshot(snapshot) : null
    guard?.discard()
    continuePendingTransition(transition)
  }, [continuePendingTransition, findGuardForSnapshot, isSavingPendingTransition, pendingTransition])

  const dialogState = useMemo<FileDirtyConfirmDialogState>(() => {
    const snapshot = pendingTransition?.snapshots[pendingTransition.currentIndex] ?? null
    return {
      open: Boolean(pendingTransition),
      snapshot,
      isSaving: isSavingPendingTransition || snapshot?.isSaving === true,
      onSave: saveAndContinue,
      onDiscard: discardAndContinue,
      onCancel: cancelPendingTransition,
    }
  }, [cancelPendingTransition, discardAndContinue, isSavingPendingTransition, pendingTransition, saveAndContinue])

  return {
    registerWritableEditor,
    getDirtySnapshot,
    requestFileEditorTransition,
    dialogState,
  }
}
