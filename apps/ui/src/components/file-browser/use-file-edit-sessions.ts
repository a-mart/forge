import { useCallback, useMemo, useRef, useState } from 'react'
import type { FileContentResult, FileVersionToken } from '@forge/protocol'
import {
  applySuccessfulFileSaveToCaches,
  fetchFileContent,
  saveFileContent,
  setFileContentCache,
} from './use-file-browser-queries'
import type {
  FileEditMode,
  FileEditSessionController,
  FileEditSessionState,
  FileSaveState,
  KeyedFileEditorContent,
} from './use-file-edit-session'
import type { FileEditorDirtySnapshot, FileEditorGuardApi, FileEditorSessionKey } from './use-file-editor-coordinator'

const EMPTY_STATE: FileEditSessionState = {
  key: null,
  mode: 'preview',
  draft: '',
  baseContent: '',
  baseVersion: null,
  dirty: false,
  focused: false,
  saveState: 'idle',
  error: null,
  conflict: null,
}

function serializeKey(key: FileEditorSessionKey): string {
  return `${key.agentId}\u0000${key.worktreeId ?? ''}\u0000${key.filePath}`
}

function fileNameFromPath(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath
}

function doesDeleteAffectFile(deletePath: string, entryType: 'file' | 'directory', filePath: string): boolean {
  const normalizedDeletePath = deletePath.replace(/^\/+|\/+$/g, '')
  const normalizedFilePath = filePath.replace(/^\/+|\/+$/g, '')
  if (!normalizedDeletePath) return false
  if (entryType === 'file') return normalizedFilePath === normalizedDeletePath
  return normalizedFilePath === normalizedDeletePath || normalizedFilePath.startsWith(`${normalizedDeletePath}/`)
}

function canEdit(key: FileEditorSessionKey | null, content: FileContentResult | null, editingEnabled: boolean): boolean {
  return Boolean(
    editingEnabled &&
      key &&
      content &&
      content.content != null &&
      content.binary === false &&
      content.editability?.editable === true &&
      content.version,
  )
}

function stateForContent(key: FileEditorSessionKey, content: FileContentResult): FileEditSessionState {
  return {
    key,
    mode: 'edit' satisfies FileEditMode,
    draft: content.content ?? '',
    baseContent: content.content ?? '',
    baseVersion: content.version as FileVersionToken,
    dirty: false,
    focused: false,
    saveState: 'idle' satisfies FileSaveState,
    error: null,
    conflict: null,
  }
}

export interface FileEditSessionsController {
  active: FileEditSessionController
  getControllerForKey: (key: FileEditorSessionKey) => FileEditorGuardApi
  getDirtySnapshotForKey: (key: FileEditorSessionKey) => FileEditorDirtySnapshot | null
  getDirtySnapshots: () => FileEditorDirtySnapshot[]
  getSessionKeys: () => FileEditorSessionKey[]
  removeSession: (key: FileEditorSessionKey) => void
  removeSessionsAffectedByDelete: (scope: { agentId: string; worktreeId: string | null; path: string; entryType: 'file' | 'directory' }) => void
  handleContentLoaded: (key: FileEditorSessionKey, content: FileContentResult | null) => void
  handleSavedContent: (saved: KeyedFileEditorContent) => void
}

export function useFileEditSessions({
  wsUrl,
  activeKey,
  editingEnabled,
  onSavedContent,
  onDirtyChange,
}: {
  wsUrl: string
  activeKey: FileEditorSessionKey | null
  editingEnabled: boolean
  onSavedContent?: (saved: KeyedFileEditorContent) => void
  onDirtyChange?: (key: FileEditorSessionKey) => void
}): FileEditSessionsController {
  const [states, setStates] = useState<Record<string, FileEditSessionState>>({})
  const [contents, setContents] = useState<Record<string, FileContentResult | null>>({})
  const statesRef = useRef(states)
  const contentsRef = useRef(contents)
  statesRef.current = states
  contentsRef.current = contents

  const activeSerializedKey = activeKey ? serializeKey(activeKey) : null
  const activeContent = activeSerializedKey ? contents[activeSerializedKey] ?? null : null
  const activeState = useMemo(
    () => activeSerializedKey
      ? (states[activeSerializedKey] ?? { ...EMPTY_STATE, key: activeKey })
      : EMPTY_STATE,
    [activeKey, activeSerializedKey, states],
  )
  const canEnterEditMode = canEdit(activeKey, activeContent, editingEnabled)

  const getState = useCallback((key: FileEditorSessionKey): FileEditSessionState => {
    return statesRef.current[serializeKey(key)] ?? { ...EMPTY_STATE, key }
  }, [])

  const updateState = useCallback((key: FileEditorSessionKey, updater: (previous: FileEditSessionState) => FileEditSessionState) => {
    setStates((previous) => {
      const serialized = serializeKey(key)
      return { ...previous, [serialized]: updater(previous[serialized] ?? { ...EMPTY_STATE, key }) }
    })
  }, [])

  const handleContentLoaded = useCallback((key: FileEditorSessionKey, content: FileContentResult | null) => {
    const serialized = serializeKey(key)
    setContents((previous) => ({ ...previous, [serialized]: content }))
    if (content && canEdit(key, content, editingEnabled)) {
      setStates((previous) => {
        const existing = previous[serialized]
        if (existing?.dirty || existing?.saveState === 'saving' || existing?.saveState === 'reloading') return previous
        return { ...previous, [serialized]: stateForContent(key, content) }
      })
    }
  }, [editingEnabled])

  const makeDirtySnapshot = useCallback((state: FileEditSessionState): FileEditorDirtySnapshot | null => {
    if (!state.key || !state.dirty) return null
    return {
      key: state.key,
      isDirty: true,
      fileName: fileNameFromPath(state.key.filePath),
      isSaving: state.saveState === 'saving' || state.saveState === 'reloading',
    }
  }, [])

  const getDirtySnapshotForKey = useCallback((key: FileEditorSessionKey): FileEditorDirtySnapshot | null => {
    return makeDirtySnapshot(getState(key))
  }, [getState, makeDirtySnapshot])

  const getDirtySnapshots = useCallback((): FileEditorDirtySnapshot[] => {
    return Object.values(statesRef.current).flatMap((state) => {
      const snapshot = makeDirtySnapshot(state)
      return snapshot ? [snapshot] : []
    })
  }, [makeDirtySnapshot])

  const getSessionKeys = useCallback((): FileEditorSessionKey[] => {
    return Object.values(statesRef.current).flatMap((state) => state.key ? [state.key] : [])
  }, [])

  const saveKey = useCallback(async (key: FileEditorSessionKey, options: { overwrite?: boolean } = {}): Promise<boolean> => {
    const serialized = serializeKey(key)
    const currentState = statesRef.current[serialized]
    if (!currentState?.key || currentState.mode !== 'edit' || !currentState.baseVersion || currentState.saveState === 'saving' || currentState.saveState === 'reloading') return false
    if (!currentState.dirty && !options.overwrite) return true

    const saveDraft = currentState.draft
    const saveBaseVersion = currentState.baseVersion
    const previousContent = contentsRef.current[serialized] ?? null
    updateState(key, (previous) => ({ ...previous, saveState: 'saving', error: null, conflict: null }))

    try {
      const result = await saveFileContent(wsUrl, {
        agentId: key.agentId,
        worktreeId: key.worktreeId,
        path: key.filePath,
        content: saveDraft,
        baseVersion: saveBaseVersion,
        overwrite: options.overwrite === true ? true : false,
      })

      if (result.success === false) {
        updateState(key, (previous) => ({ ...previous, saveState: 'conflict', conflict: result, error: null, dirty: true }))
        return false
      }

      const applied = applySuccessfulFileSaveToCaches({
        agentId: key.agentId,
        worktreeId: key.worktreeId,
        filePath: key.filePath,
        previousContent,
        draftContent: saveDraft,
        saveResponse: result,
      })
      setContents((previous) => ({ ...previous, [serialized]: applied.content }))
      onSavedContent?.({ key, content: applied.content })
      updateState(key, (previous) => {
        const draftChangedDuringSave = previous.draft !== saveDraft
        return {
          ...previous,
          draft: draftChangedDuringSave ? previous.draft : saveDraft,
          baseContent: saveDraft,
          baseVersion: result.version,
          dirty: draftChangedDuringSave,
          saveState: 'saved',
          error: null,
          conflict: null,
        }
      })
      return true
    } catch (error) {
      updateState(key, (previous) => ({
        ...previous,
        saveState: 'error',
        error: error instanceof Error ? error.message : 'Failed to save file',
        conflict: null,
      }))
      return false
    }
  }, [onSavedContent, updateState, wsUrl])

  const reloadKey = useCallback(async (key: FileEditorSessionKey): Promise<boolean> => {
    const currentState = getState(key)
    if (!currentState.key || currentState.mode !== 'edit' || currentState.saveState === 'saving' || currentState.saveState === 'reloading') return false
    const reloadDraftSnapshot = currentState.draft
    updateState(key, (previous) => ({ ...previous, saveState: 'reloading', error: null, conflict: null }))
    try {
      const fresh = await fetchFileContent(wsUrl, key.agentId, key.filePath, key.worktreeId)
      if (fresh.binary || fresh.content == null || !fresh.version || fresh.editability?.editable !== true) {
        updateState(key, (previous) => ({
          ...previous,
          saveState: 'error',
          error: fresh.binary ? 'Cannot reload a binary file into the editor.' : 'Unable to reload file from disk.',
          conflict: null,
        }))
        return false
      }
      setFileContentCache(key.agentId, key.worktreeId, key.filePath, fresh)
      setContents((previous) => ({ ...previous, [serializeKey(key)]: fresh }))
      onSavedContent?.({ key, content: fresh })
      updateState(key, (previous) => {
        if (previous.draft !== reloadDraftSnapshot) return { ...previous, saveState: 'idle', error: null, conflict: null }
        return {
          ...previous,
          draft: fresh.content ?? '',
          baseContent: fresh.content ?? '',
          baseVersion: fresh.version ?? null,
          dirty: false,
          saveState: 'idle',
          error: null,
          conflict: null,
        }
      })
      return true
    } catch (error) {
      updateState(key, (previous) => ({
        ...previous,
        saveState: 'error',
        error: error instanceof Error ? error.message : 'Failed to reload file from disk',
        conflict: null,
      }))
      return false
    }
  }, [getState, onSavedContent, updateState, wsUrl])

  const discardKey = useCallback((key: FileEditorSessionKey) => {
    updateState(key, (previous) => {
      if (previous.saveState === 'saving' || previous.saveState === 'reloading') return previous
      return { ...previous, draft: previous.baseContent, dirty: false, mode: 'edit', saveState: 'idle', error: null, conflict: null }
    })
  }, [updateState])

  const getControllerForKey = useCallback((key: FileEditorSessionKey): FileEditorGuardApi => ({
    getSnapshot: () => getDirtySnapshotForKey(key),
    save: () => saveKey(key),
    discard: () => discardKey(key),
  }), [discardKey, getDirtySnapshotForKey, saveKey])

  const removeSession = useCallback((key: FileEditorSessionKey) => {
    const serialized = serializeKey(key)
    setStates((previous) => {
      const next = { ...previous }
      delete next[serialized]
      return next
    })
    setContents((previous) => {
      const next = { ...previous }
      delete next[serialized]
      return next
    })
  }, [])

  const removeSessionsAffectedByDelete = useCallback(({ agentId, worktreeId, path, entryType }: { agentId: string; worktreeId: string | null; path: string; entryType: 'file' | 'directory' }) => {
    const shouldRemove = (state: FileEditSessionState | undefined) => Boolean(
      state?.key &&
      state.key.agentId === agentId &&
      state.key.worktreeId === worktreeId &&
      doesDeleteAffectFile(path, entryType, state.key.filePath),
    )

    setStates((previous) => Object.fromEntries(Object.entries(previous).filter(([, state]) => !shouldRemove(state))))
    setContents((previous) => Object.fromEntries(Object.entries(previous).filter(([serialized]) => !shouldRemove(statesRef.current[serialized]))))
  }, [])

  const handleSavedContent = useCallback((saved: KeyedFileEditorContent) => {
    setContents((previous) => ({ ...previous, [serializeKey(saved.key)]: saved.content }))
  }, [])

  const activeController = useMemo<FileEditSessionController>(() => ({
    state: activeState,
    canEnterEditMode,
    enterEditMode: () => {
      if (!activeKey || !activeContent || !canEnterEditMode) return
      updateState(activeKey, () => stateForContent(activeKey, activeContent))
    },
    updateDraft: (next: string) => {
      if (!activeKey) return
      updateState(activeKey, (previous) => {
        if (previous.mode !== 'edit' || previous.saveState === 'saving' || previous.saveState === 'reloading') return previous
        const wasDirty = previous.dirty
        const dirty = next !== previous.baseContent
        if (!wasDirty && dirty) onDirtyChange?.(activeKey)
        return { ...previous, draft: next, dirty, saveState: 'idle', error: null, conflict: null }
      })
    },
    setFocused: (focused: boolean) => {
      if (activeKey) updateState(activeKey, (previous) => ({ ...previous, focused }))
    },
    save: (options?: { overwrite?: boolean }) => activeKey ? saveKey(activeKey, options) : Promise.resolve(false),
    reloadFromDisk: () => activeKey ? reloadKey(activeKey) : Promise.resolve(false),
    dismissConflict: () => {
      if (activeKey) updateState(activeKey, (previous) => previous.saveState !== 'conflict' && !previous.conflict
        ? previous
        : { ...previous, saveState: 'idle', conflict: null, error: null })
    },
    revert: () => {
      if (activeKey) updateState(activeKey, (previous) => previous.mode !== 'edit'
        ? previous
        : { ...previous, draft: previous.baseContent, dirty: false, saveState: 'idle', error: null, conflict: null })
    },
    discard: () => {
      if (activeKey) discardKey(activeKey)
    },
    getDirtySnapshot: () => activeKey ? getDirtySnapshotForKey(activeKey) : null,
  }), [activeContent, activeKey, activeState, canEnterEditMode, discardKey, getDirtySnapshotForKey, onDirtyChange, reloadKey, saveKey, updateState])

  return {
    active: activeController,
    getControllerForKey,
    getDirtySnapshotForKey,
    getDirtySnapshots,
    getSessionKeys,
    removeSession,
    removeSessionsAffectedByDelete,
    handleContentLoaded,
    handleSavedContent,
  }
}
