/* eslint-disable react-refresh/only-export-components -- component and its companion hook are tightly coupled */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  FileText,
  FileWarning,
  Loader2,
  AlertTriangle,
  Copy,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  detectLanguage,
  highlightCode,
  getLanguageDisplayName,
} from '@/lib/syntax-highlight'
import '@/styles/syntax-highlight.css'
import '@/styles/file-browser.css'
import { FileContentHeader } from './FileContentHeader'
import type { FileEditSessionController } from './use-file-edit-session'
import { formatFileSize, isImageFile, isPdfFile } from './file-browser-utils'
import { ImagePreview } from './ImagePreview'
import { PdfPreview } from './PdfPreview'
import { MarkdownPreview } from './MarkdownPreview'
import type { FileContentResult } from './use-file-browser-queries'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

const CodeMirrorFileEditorLazy = lazy(async () => {
  const module = await import('./CodeMirrorFileEditor')
  return { default: module.CodeMirrorFileEditor }
})

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const WORD_WRAP_STORAGE_KEY = 'forge-file-browser-word-wrap'
const MARKDOWN_RAW_STORAGE_KEY = 'forge-file-browser-markdown-raw'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return MARKDOWN_EXTENSIONS.has(ext)
}

function readMarkdownRawPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MARKDOWN_RAW_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function storeMarkdownRawPreference(value: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MARKDOWN_RAW_STORAGE_KEY, String(value))
  } catch {
    // Ignore
  }
}

function readWordWrapPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(WORD_WRAP_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function storeWordWrapPreference(value: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORD_WRAP_STORAGE_KEY, String(value))
  } catch {
    // Ignore
  }
}

/* ------------------------------------------------------------------ */
/*  Public interface                                                    */
/* ------------------------------------------------------------------ */

interface FileContentViewerProps {
  wsUrl: string
  agentId: string
  cwd: string
  filePath: string | null
  content: FileContentResult | null
  isLoading: boolean
  error: string | null
  onNavigateToDirectory: (dirPath: string) => void
  worktreeId?: string | null
  inlineEditingEnabled?: boolean
  editSession?: FileEditSessionController | null
}

interface FileViewerInfo {
  language: string | undefined
  languageDisplayName: string | undefined
  lineCount: number | null
  fileSize: number | null
  encoding: FileContentResult['encoding'] | null
  editability: FileContentResult['editability'] | null
  version: FileContentResult['version'] | null
  isMarkdown: boolean
  markdownRaw: boolean
}

export function FileContentViewer({
  wsUrl,
  agentId,
  cwd,
  filePath,
  content,
  isLoading,
  error,
  onNavigateToDirectory,
  worktreeId = null,
  inlineEditingEnabled = false,
  editSession = null,
}: FileContentViewerProps) {
  const [wordWrap, setWordWrap] = useState(readWordWrapPreference)
  const [markdownRaw, setMarkdownRaw] = useState(readMarkdownRawPreference)
  const [copied, setCopied] = useState(false)
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false)

  // Detect language — always compute, before any early returns
  const language = useMemo(
    () => (filePath ? detectLanguage(filePath) : undefined),
    [filePath],
  )

  const isImage = useMemo(
    () => (filePath ? isImageFile(filePath) : false),
    [filePath],
  )

  const isPdf = useMemo(
    () => (filePath ? isPdfFile(filePath) : false),
    [filePath],
  )

  const isMarkdown = useMemo(
    () => (filePath ? isMarkdownFile(filePath) : false),
    [filePath],
  )

  const handleToggleWordWrap = useCallback(() => {
    setWordWrap((prev) => {
      const next = !prev
      storeWordWrapPreference(next)
      return next
    })
  }, [])

  const handleToggleMarkdownRaw = useCallback(() => {
    setMarkdownRaw((prev) => {
      const next = !prev
      storeMarkdownRawPreference(next)
      return next
    })
  }, [])

  const contentText = content?.content
  const editState = editSession?.state
  const canEdit = inlineEditingEnabled && Boolean(editSession?.canEnterEditMode)
  const isEditing = canEdit
  const editorLocked = editState?.saveState === 'saving' || editState?.saveState === 'reloading'
  const conflictActionsDisabled = editorLocked
  const effectiveMarkdownRaw = markdownRaw || (isMarkdown && isEditing)

  useEffect(() => {
    if (isEditing && isMarkdown && !markdownRaw) {
      setMarkdownRaw(true)
      storeMarkdownRawPreference(true)
    }
  }, [isEditing, isMarkdown, markdownRaw])

  const handleCopyContent = useCallback(async () => {
    if (!contentText) return
    try {
      await navigator.clipboard.writeText(contentText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available
    }
  }, [contentText])

  const handleReloadFromDisk = useCallback(async () => {
    if (!editSession || editorLocked) return
    await editSession.reloadFromDisk()
    setReloadConfirmOpen(false)
  }, [editSession, editorLocked])

  const fileName = filePath?.split('/').pop() ?? ''

  // --- Empty state (no file selected) ---
  if (!filePath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileText className="size-10 opacity-20" />
        <p className="text-sm">Select a file to view</p>
      </div>
    )
  }

  // --- Image files: rendered directly via GET, no content fetch needed ---
  if (isImage) {
    return (
      <div className="flex flex-1 flex-col" role="region" aria-label={`File content: ${fileName}`}>
        <FileContentHeader
          filePath={filePath}
          cwd={cwd}
          wordWrap={wordWrap}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <ImagePreview
          key={`${agentId}:${worktreeId ?? 'session'}:${filePath}`}
          wsUrl={wsUrl}
          filePath={filePath}
          agentId={agentId}
          worktreeId={worktreeId}
        />
      </div>
    )
  }

  // --- PDF files: streamed via /api/files/raw, no JSON content fetch needed ---
  if (isPdf) {
    return (
      <div className="flex flex-1 flex-col" role="region" aria-label={`File content: ${fileName}`}>
        <FileContentHeader
          filePath={filePath}
          cwd={cwd}
          wordWrap={wordWrap}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <PdfPreview
          key={`${agentId}:${worktreeId ?? 'session'}:${filePath}`}
          wsUrl={wsUrl}
          filePath={filePath}
          agentId={agentId}
          worktreeId={worktreeId}
        />
      </div>
    )
  }

  // --- Loading state ---
  if (isLoading && !content) {
    return (
      <div className="flex flex-1 flex-col" role="region" aria-label={`File content: ${fileName}`}>
        <FileContentHeader
          filePath={filePath}
          cwd={cwd}
          wordWrap={wordWrap}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // --- Error state ---
  if (error) {
    const isTooLarge =
      error.toLowerCase().includes('too large') ||
      error.toLowerCase().includes('exceeds')

    return (
      <div className="flex flex-1 flex-col" role="region" aria-label={`File content: ${fileName}`}>
        <FileContentHeader
          filePath={filePath}
          cwd={cwd}
          wordWrap={wordWrap}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          {isTooLarge ? (
            <>
              <FileText className="size-10 opacity-40" />
              <p className="text-sm">File too large to display</p>
              <p className="text-xs opacity-60">Files over 2 MB cannot be displayed</p>
            </>
          ) : (
            <>
              <AlertTriangle className="size-8 text-destructive/60" />
              <p className="text-sm">Failed to load file</p>
              <p className="text-xs opacity-60">{error}</p>
            </>
          )}
        </div>
      </div>
    )
  }

  // --- Binary file ---
  if (content?.binary) {
    return (
      <div className="flex flex-1 flex-col" role="region" aria-label={`File content: ${fileName}`}>
        <FileContentHeader
          filePath={filePath}
          cwd={cwd}
          wordWrap={wordWrap}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <FileWarning className="size-10 opacity-40" />
          <p className="text-sm">Binary file — cannot display</p>
          {content.size != null && (
            <p className="text-xs opacity-60">{formatFileSize(content.size)}</p>
          )}
        </div>
      </div>
    )
  }

  // --- Text content ---
  const text = content?.content ?? ''

  // --- Markdown file: show rendered or raw based on toggle. Editable markdown opens as source. ---
  if (isMarkdown && !effectiveMarkdownRaw && !isEditing) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden" role="region" aria-label={`File content: ${fileName}`}>
        <FileContentHeader
          filePath={filePath}
          cwd={cwd}
          wordWrap={wordWrap}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
          isMarkdown
          markdownRaw={effectiveMarkdownRaw}
          onToggleMarkdownRaw={handleToggleMarkdownRaw}
          editMode={isEditing}
          dirty={editState?.dirty ?? false}
          saveState={editState?.saveState}
          onSave={() => void editSession?.save()}
          onRevert={editSession?.revert}
        />
        <MarkdownPreview content={text} />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden" role="region" aria-label={`File content: ${fileName}`}>
      <FileContentHeader
        filePath={filePath}
        cwd={cwd}
        wordWrap={wordWrap}
        onToggleWordWrap={handleToggleWordWrap}
        onNavigateToDirectory={onNavigateToDirectory}
        isMarkdown={isMarkdown}
        markdownRaw={effectiveMarkdownRaw}
        onToggleMarkdownRaw={handleToggleMarkdownRaw}
        editMode={isEditing}
        dirty={editState?.dirty ?? false}
        saveState={editState?.saveState}
        onSave={() => void editSession?.save()}
        onRevert={editSession?.revert}
      />

      {editState?.error || editState?.conflict ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {editState.conflict ? 'This file changed on disk since you opened it.' : editState.error}
          {editState.conflict ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="font-medium underline underline-offset-2 disabled:opacity-60"
                disabled={conflictActionsDisabled}
                onClick={() => setReloadConfirmOpen(true)}
              >
                {editState?.saveState === 'reloading' ? 'Reloading…' : 'Reload from disk'}
              </button>
              <button
                type="button"
                className="font-medium underline underline-offset-2 disabled:opacity-60"
                disabled={conflictActionsDisabled}
                onClick={() => void editSession?.save({ overwrite: true })}
              >
                Overwrite anyway
              </button>
              <button
                type="button"
                className="font-medium underline underline-offset-2 disabled:opacity-60"
                disabled={conflictActionsDisabled}
                onClick={() => editSession?.dismissConflict()}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {isEditing ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense
            fallback={(
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          >
            <CodeMirrorFileEditorLazy
              value={editState?.mode === 'edit' ? editState.draft : text}
              language={language}
              wordWrap={wordWrap}
              readOnly={editorLocked}
              ariaLabel={`Editing ${fileName}`}
              onChange={(next) => editSession?.updateDraft(next)}
              onFocusedChange={(focused) => editSession?.setFocused(focused)}
              onSaveShortcut={() => {
                if (!editorLocked) {
                  void editSession?.save()
                }
              }}
            />
          </Suspense>
        </div>
      ) : (
      /* Copy content button — floating top-right of code area */
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute right-3 top-2 z-10">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex size-7 items-center justify-center rounded-md border border-border/50 bg-card/90 text-muted-foreground transition-colors',
                    'hover:bg-muted hover:text-foreground',
                  )}
                  onClick={handleCopyContent}
                  aria-label="Copy file content"
                >
                  {copied ? (
                    <Check className="size-3.5 text-green-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={4}>
                {copied ? 'Copied!' : 'Copy content'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <CodeView content={text} language={language} wordWrap={wordWrap} />
      </div>
      )}

      <AlertDialog open={reloadConfirmOpen} onOpenChange={(open) => {
        if (!editorLocked) {
          setReloadConfirmOpen(open)
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reload from disk?</AlertDialogTitle>
            <AlertDialogDescription>
              Discard your unsaved changes and reload {fileName} from disk?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={editorLocked}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={editorLocked}
              onClick={() => void handleReloadFromDisk()}
            >
              {editState?.saveState === 'reloading' ? 'Reloading…' : 'Discard and reload'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Return file viewer info for the status bar, without rendering.
 */
export function useFileViewerInfo(
  filePath: string | null,
  content: FileContentResult | null,
  markdownRaw?: boolean,
): FileViewerInfo {
  const language = useMemo(
    () => (filePath ? detectLanguage(filePath) : undefined),
    [filePath],
  )

  const languageDisplayName = useMemo(
    () => getLanguageDisplayName(language),
    [language],
  )

  const isMarkdown = useMemo(
    () => (filePath ? isMarkdownFile(filePath) : false),
    [filePath],
  )

  return {
    language,
    languageDisplayName,
    lineCount: content?.lines ?? null,
    fileSize: content?.size ?? null,
    encoding: content?.encoding ?? null,
    editability: content?.editability ?? null,
    version: content?.version ?? null,
    isMarkdown,
    markdownRaw: markdownRaw ?? false,
  }
}

/* ------------------------------------------------------------------ */
/*  Code View (syntax-highlighted with line numbers)                   */
/* ------------------------------------------------------------------ */

function CodeView({
  content,
  language,
  wordWrap,
}: {
  content: string
  language: string | undefined
  wordWrap: boolean
}) {
  const lines = useMemo(() => content.split('\n'), [content])

  const highlightedLines = useMemo(() => {
    return lines.map((line) => highlightCode(line, language))
  }, [lines, language])

  // Width of line number gutter based on total line count
  const gutterWidth = useMemo(() => {
    const digits = String(lines.length).length
    // Each digit ~8px + 24px padding
    return Math.max(digits * 8 + 24, 48)
  }, [lines.length])

  return (
    <div
      className={cn(
        'syntax-highlight file-browser-scroll h-full overflow-auto font-mono text-[13px] leading-[21px]',
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {highlightedLines.map((html, i) => (
            <tr key={i} className="hover:bg-muted/30">
              <td
                className="sticky left-0 z-[1] select-none border-r border-border/30 bg-card/80 pr-3 text-right align-top text-muted-foreground/40"
                style={{ width: gutterWidth, minWidth: gutterWidth }}
              >
                <span className="leading-[21px]">{i + 1}</span>
              </td>
              <td
                className={cn(
                  'pl-4 align-top',
                  wordWrap
                    ? 'whitespace-pre-wrap break-all'
                    : 'whitespace-pre',
                )}
              >
                <span
                  className="leading-[21px]"
                  dangerouslySetInnerHTML={{
                    __html: html || '&nbsp;',
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
