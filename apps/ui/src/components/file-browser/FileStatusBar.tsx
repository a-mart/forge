import type { ReactNode } from 'react'
import type { FileContentResult } from './use-file-browser-queries'
import { formatFileSize } from './file-browser-utils'

interface FileStatusBarProps {
  fileCount: number | null
  fileCountMethod: string | null
  selectedFile: string | null
  languageDisplayName?: string | undefined
  lineCount?: number | null
  fileSize?: number | null
  encoding?: FileContentResult['encoding'] | null
  editability?: FileContentResult['editability'] | null
  isDirty?: boolean
  saveState?: 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'reloading'
}

export function FileStatusBar({
  fileCount,
  fileCountMethod,
  selectedFile,
  languageDisplayName,
  lineCount,
  fileSize,
  encoding,
  editability,
  isDirty = false,
  saveState,
}: FileStatusBarProps) {
  const statusLabel = editability?.editable === false
    ? 'Read-only'
    : encoding === 'utf8'
      ? 'UTF-8'
      : null
  const hasFileInfo = selectedFile && (languageDisplayName || lineCount != null || fileSize != null || statusLabel || editability)

  return (
    <div
      className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {hasFileInfo ? (
        <div className="flex items-center gap-2 text-[11px]">
          {saveState && saveState !== 'idle' ? <span className="text-muted-foreground/60">{formatSaveState(saveState)}</span> : null}
          {isDirty ? <StatusBarPart withSeparator={!!saveState && saveState !== 'idle'}>Unsaved</StatusBarPart> : null}
          {statusLabel ? <StatusBarPart withSeparator={Boolean((saveState && saveState !== 'idle') || isDirty)}>{statusLabel}</StatusBarPart> : null}
          {editability?.editable === false && editability.reason ? (
            <StatusBarPart withSeparator={Boolean(statusLabel || saveState || isDirty)}>{formatEditabilityReason(editability.reason)}</StatusBarPart>
          ) : null}
          {languageDisplayName && (
            <StatusBarPart withSeparator={Boolean(statusLabel || saveState || isDirty || editability?.editable === false)}>{languageDisplayName}</StatusBarPart>
          )}
          {lineCount != null && (
            <StatusBarPart withSeparator={Boolean(statusLabel || saveState || isDirty || editability?.editable === false || languageDisplayName)}>
              {lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'}
            </StatusBarPart>
          )}
          {fileSize != null && (
            <StatusBarPart withSeparator={Boolean(statusLabel || saveState || isDirty || editability?.editable === false || languageDisplayName || lineCount != null)}>
              {formatFileSize(fileSize)}
            </StatusBarPart>
          )}
        </div>
      ) : selectedFile ? (
        <span className="truncate font-mono text-[11px]">{selectedFile}</span>
      ) : (
        <span className="text-[11px] text-muted-foreground/60">
          {fileCount !== null && fileCountMethod !== 'none'
            ? `${fileCount.toLocaleString()} files in repository`
            : 'No file selected'}
        </span>
      )}
    </div>
  )
}

function StatusBarPart({ children, withSeparator }: { children: ReactNode; withSeparator: boolean }) {
  return (
    <>
      {withSeparator ? <span className="text-muted-foreground/30">·</span> : null}
      <span>{children}</span>
    </>
  )
}

function formatSaveState(saveState: NonNullable<FileStatusBarProps['saveState']>): string {
  switch (saveState) {
    case 'saving':
      return 'Saving…'
    case 'reloading':
      return 'Reloading…'
    case 'saved':
      return 'Saved'
    case 'error':
      return 'Error'
    case 'conflict':
      return 'Conflict'
    default:
      return 'Editing'
  }
}

function formatEditabilityReason(reason: NonNullable<FileContentResult['editability']>['reason']): string {
  switch (reason) {
    case 'binary':
      return 'Binary'
    case 'too_large':
      return 'Too large to edit'
    case 'unsupported_encoding':
      return 'Unsupported encoding'
    case 'not_file':
      return 'Not a file'
    case 'read_error':
      return 'Read error'
    default:
      return 'Read-only'
  }
}
