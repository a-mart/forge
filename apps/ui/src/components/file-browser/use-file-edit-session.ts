import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileContentResult, FileSaveConflictResponse, FileVersionToken } from '@forge/protocol'
import {
  applySuccessfulFileSaveToCaches,
  fetchFileContent,
  saveFileContent,
  setFileContentCache,
} from './use-file-browser-queries'
import type { FileEditorDirtySnapshot, FileEditorSessionKey } from './use-file-editor-coordinator'

export type FileEditMode = 'preview' | 'edit'
export type FileSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'reloading'

export interface FileEditSessionState {
  key: FileEditorSessionKey | null
  mode: FileEditMode
  draft: string
  baseContent: string
  baseVersion: FileVersionToken | null
  dirty: boolean
  focused: boolean
  saveState: FileSaveState
  error: string | null
  conflict: FileSaveConflictResponse | null
}

export interface KeyedFileEditorContent {
  key: FileEditorSessionKey
  content: FileContentResult | null
}

export interface FileEditSessionController {
  state: FileEditSessionState
  canEnterEditMode: boolean
  enterEditMode: () => void
  updateDraft: (next: string) => void
  setFocused: (focused: boolean) => void
  save: (options?: { overwrite?: boolean }) => Promise<boolean>
  reloadFromDisk: () => Promise<boolean>
  dismissConflict: () => void
  revert: () => void
  discard: () => void
  getDirtySnapshot: () => FileEditorDirtySnapshot | null
}

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

function keysEqual(a: FileEditorSessionKey | null, b: FileEditorSessionKey | null): boolean {
  return a?.agentId === b?.agentId && a?.worktreeId === b?.worktreeId && a?.filePath === b?.filePath
}

function fileNameFromPath(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath
}

function keyedContentMatches(key: FileEditorSessionKey | null, keyedContent: KeyedFileEditorContent | null): boolean {
  return Boolean(key && keyedContent && keysEqual(key, keyedContent.key))
}

export function useFileEditSession({
  wsUrl,
  key,
  content,
  editingEnabled,
  onSavedContent,
}: {
  wsUrl: string
  key: FileEditorSessionKey | null
  content: KeyedFileEditorContent | null
  editingEnabled: boolean
  onSavedContent?: (saved: KeyedFileEditorContent) => void
}): FileEditSessionController {
  const [state, setState] = useState<FileEditSessionState>(EMPTY_STATE)
  const activeKeyRef = useRef<FileEditorSessionKey | null>(key)
  const stateRef = useRef(state)
  const saveTokenRef = useRef<symbol | null>(null)
  const contentForKey = keyedContentMatches(key, content) ? content?.content ?? null : null
  activeKeyRef.current = key
  stateRef.current = state

  const canEnterEditMode = Boolean(
    editingEnabled &&
      key &&
      contentForKey &&
      contentForKey.content != null &&
      contentForKey.binary === false &&
      contentForKey.editability?.editable === true &&
      contentForKey.version,
  )

  useEffect(() => {
    setState((previous) => {
      if (keysEqual(previous.key, key)) {
        return previous
      }
      return {
        ...EMPTY_STATE,
        key,
      }
    })
  }, [key])

  const enterEditMode = useCallback(() => {
    if (!key || !contentForKey?.version || contentForKey.content == null || !canEnterEditMode) return
    setState({
      key,
      mode: 'edit',
      draft: contentForKey.content,
      baseContent: contentForKey.content,
      baseVersion: contentForKey.version,
      dirty: false,
      focused: false,
      saveState: 'idle',
      error: null,
      conflict: null,
    })
  }, [canEnterEditMode, contentForKey, key])

  const updateDraft = useCallback((next: string) => {
    setState((previous) => {
      // Lean MVP contract: draft input is locked while save/reload is in flight.
      if (
        previous.mode !== 'edit' ||
        previous.saveState === 'saving' ||
        previous.saveState === 'reloading'
      ) {
        return previous
      }
      return {
        ...previous,
        draft: next,
        dirty: next !== previous.baseContent,
        saveState: 'idle',
        error: null,
        conflict: null,
      }
    })
  }, [])

  const setFocused = useCallback((focused: boolean) => {
    setState((previous) => ({ ...previous, focused }))
  }, [])

  const save = useCallback(async (options: { overwrite?: boolean } = {}) => {
    const currentState = stateRef.current
    if (!currentState.key || currentState.mode !== 'edit' || !currentState.baseVersion || currentState.saveState === 'saving' || currentState.saveState === 'reloading') {
      return false
    }

    if (!currentState.dirty && !options.overwrite) {
      return true
    }

    const saveKey = currentState.key
    const saveDraft = currentState.draft
    const saveBaseVersion = currentState.baseVersion
    const previousContent = contentForKey
    const saveToken = Symbol('file-save')
    saveTokenRef.current = saveToken

    const isCurrentSave = () => saveTokenRef.current === saveToken && keysEqual(activeKeyRef.current, saveKey)

    setState((previous) => keysEqual(previous.key, saveKey)
      ? { ...previous, saveState: 'saving', error: null, conflict: null }
      : previous)

    try {
      const result = await saveFileContent(wsUrl, {
        agentId: saveKey.agentId,
        worktreeId: saveKey.worktreeId,
        path: saveKey.filePath,
        content: saveDraft,
        baseVersion: saveBaseVersion,
        overwrite: options.overwrite === true ? true : false,
      })

      if (!isCurrentSave()) {
        return false
      }

      if (result.success === false) {
        setState((previous) => keysEqual(previous.key, saveKey)
          ? {
              ...previous,
              saveState: 'conflict',
              conflict: result,
              error: null,
              dirty: true,
            }
          : previous)
        return false
      }

      const applied = applySuccessfulFileSaveToCaches({
        agentId: saveKey.agentId,
        worktreeId: saveKey.worktreeId,
        filePath: saveKey.filePath,
        previousContent,
        draftContent: saveDraft,
        saveResponse: result,
      })
      onSavedContent?.({ key: saveKey, content: applied.content })

      setState((previous) => keysEqual(previous.key, saveKey)
        ? (() => {
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
          })()
        : previous)
      return true
    } catch (error) {
      if (!isCurrentSave()) {
        return false
      }
      setState((previous) => keysEqual(previous.key, saveKey)
        ? {
            ...previous,
            saveState: 'error',
            error: error instanceof Error ? error.message : 'Failed to save file',
            conflict: null,
          }
        : previous)
      return false
    }
  }, [contentForKey, onSavedContent, wsUrl])

  const reloadFromDisk = useCallback(async (): Promise<boolean> => {
    const currentState = stateRef.current
    if (!currentState.key || currentState.mode !== 'edit' || currentState.saveState === 'saving' || currentState.saveState === 'reloading') {
      return false
    }

    const reloadKey = currentState.key
    const reloadDraftSnapshot = currentState.draft
    const isCurrentReload = () => keysEqual(activeKeyRef.current, reloadKey)

    setState((previous) => keysEqual(previous.key, reloadKey)
      ? { ...previous, saveState: 'reloading', error: null, conflict: null }
      : previous)

    try {
      const fresh = await fetchFileContent(
        wsUrl,
        reloadKey.agentId,
        reloadKey.filePath,
        reloadKey.worktreeId,
      )

      if (!isCurrentReload()) {
        return false
      }

      if (fresh.binary || fresh.content == null || !fresh.version || fresh.editability?.editable !== true) {
        setState((previous) => keysEqual(previous.key, reloadKey)
          ? {
              ...previous,
              saveState: 'error',
              error: fresh.binary
                ? 'Cannot reload a binary file into the editor.'
                : 'Unable to reload file from disk.',
              conflict: null,
            }
          : previous)
        return false
      }

      const reloadedContent = fresh.content
      const reloadedVersion = fresh.version

      setFileContentCache(reloadKey.agentId, reloadKey.worktreeId, reloadKey.filePath, fresh)
      onSavedContent?.({ key: reloadKey, content: fresh })

      setState((previous) => keysEqual(previous.key, reloadKey)
        ? (() => {
            const draftChangedDuringReload = previous.draft !== reloadDraftSnapshot
            if (draftChangedDuringReload) {
              return {
                ...previous,
                saveState: 'idle',
                error: null,
                conflict: null,
              }
            }
            return {
              ...previous,
              draft: reloadedContent,
              baseContent: reloadedContent,
              baseVersion: reloadedVersion,
              dirty: false,
              saveState: 'idle',
              error: null,
              conflict: null,
            }
          })()
        : previous)
      return true
    } catch (error) {
      if (!isCurrentReload()) {
        return false
      }
      setState((previous) => keysEqual(previous.key, reloadKey)
        ? {
            ...previous,
            saveState: 'error',
            error: error instanceof Error ? error.message : 'Failed to reload file from disk',
            conflict: null,
          }
        : previous)
      return false
    }
  }, [onSavedContent, wsUrl])

  const dismissConflict = useCallback(() => {
    setState((previous) => {
      if (previous.saveState !== 'conflict' && !previous.conflict) {
        return previous
      }
      return {
        ...previous,
        saveState: 'idle',
        conflict: null,
        error: null,
      }
    })
  }, [])

  const revert = useCallback(() => {
    setState((previous) => {
      if (previous.mode !== 'edit') return previous
      return {
        ...previous,
        draft: previous.baseContent,
        dirty: false,
        saveState: 'idle',
        error: null,
        conflict: null,
      }
    })
  }, [])

  const discard = useCallback(() => {
    setState((previous) => {
      if (previous.saveState === 'saving' || previous.saveState === 'reloading') return previous
      return {
        ...previous,
        draft: previous.baseContent,
        dirty: false,
        mode: 'preview',
        saveState: 'idle',
        error: null,
        conflict: null,
      }
    })
  }, [])

  const getDirtySnapshot = useCallback((): FileEditorDirtySnapshot | null => {
    if (!state.key || !state.dirty) return null
    return {
      key: state.key,
      isDirty: true,
      fileName: fileNameFromPath(state.key.filePath),
      isSaving: state.saveState === 'saving' || state.saveState === 'reloading',
    }
  }, [state.dirty, state.key, state.saveState])

  return useMemo(() => ({
    state,
    canEnterEditMode,
    enterEditMode,
    updateDraft,
    setFocused,
    save,
    reloadFromDisk,
    dismissConflict,
    revert,
    discard,
    getDirtySnapshot,
  }), [canEnterEditMode, discard, dismissConflict, enterEditMode, getDirtySnapshot, reloadFromDisk, revert, save, setFocused, state, updateDraft])
}
