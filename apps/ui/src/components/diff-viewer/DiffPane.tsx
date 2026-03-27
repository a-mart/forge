import { useMemo, type ReactElement } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { FileText, AlertTriangle, Loader2 } from 'lucide-react'
import { detectLanguage, highlightCode } from '@/lib/syntax-highlight'
import { MarkdownDiffPane } from './MarkdownDiffPane'
import { useDiffTheme } from './diff-viewer-theme'
import '@/styles/syntax-highlight.css'
import './syntax-highlight.css'

interface DiffPaneProps {
  oldContent: string | null
  newContent: string | null
  fileName: string | null
  isLoading: boolean
  error: string | null
  truncated?: boolean
  truncatedReason?: string
}

export function DiffPane({
  oldContent,
  newContent,
  fileName,
  isLoading,
  error,
  truncated,
  truncatedReason,
}: DiffPaneProps) {
  const { styles, useDarkTheme } = useDiffTheme()

  // Detect language for syntax highlighting based on file extension
  // NOTE: All hooks must be called unconditionally before any early returns
  // to satisfy React's rules of hooks (error #310: "Rendered more hooks than
  // during the previous render").
  const language = useMemo(() => detectLanguage(fileName ?? ''), [fileName])
  const isMarkdownFile = useMemo(() => isMarkdownDiffFile(fileName), [fileName])

  const renderContent = useMemo(() => {
    return (source: string): ReactElement => {
      const html = highlightCode(source, language)
      return <span dangerouslySetInnerHTML={{ __html: html }} />
    }
  }, [language])

  // No file selected
  if (!fileName) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <FileText className="mb-2 size-10 opacity-30" />
        <span className="text-sm">Select a file to view changes</span>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
          <AlertTriangle className="mb-2 size-8 text-destructive/60" />
          <span className="text-sm">Failed to load diff</span>
          <span className="mt-1 text-xs opacity-60">{error}</span>
        </div>
      </div>
    )
  }

  // Truncated (file too large)
  if (truncated) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
          <FileText className="mb-2 size-8 opacity-40" />
          <span className="text-sm">File too large to display</span>
          {truncatedReason ? (
            <span className="mt-1 text-xs opacity-60">{truncatedReason}</span>
          ) : null}
        </div>
      </div>
    )
  }

  // Check for binary-ish content (null bytes in first 8KB)
  const isBinary =
    (oldContent != null && containsNullBytes(oldContent)) ||
    (newContent != null && containsNullBytes(newContent))

  if (isBinary) {
    return (
      <div className="flex h-full flex-col">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
          <FileText className="mb-2 size-8 opacity-40" />
          <span className="text-sm">Binary file — cannot display diff</span>
        </div>
      </div>
    )
  }

  if (isMarkdownFile) {
    return (
      <MarkdownDiffPane
        fileName={fileName}
        oldContent={oldContent ?? ''}
        newContent={newContent ?? ''}
      />
    )
  }

  return (
    <div className="syntax-highlight flex h-full flex-col overflow-hidden">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
      </div>
      <div className="flex-1 overflow-auto">
        <ReactDiffViewer
          oldValue={oldContent ?? ''}
          newValue={newContent ?? ''}
          splitView={false}
          useDarkTheme={useDarkTheme}
          styles={styles}
          compareMethod={DiffMethod.WORDS}
          extraLinesSurroundingDiff={3}
          showDiffOnly={true}
          renderContent={renderContent}
          codeFoldMessageRenderer={(totalLines: number) => (
            <span className="text-xs text-muted-foreground">
              Expand {totalLines} unchanged lines
            </span>
          )}
        />
      </div>
    </div>
  )
}

function containsNullBytes(str: string): boolean {
  const check = str.slice(0, 8192)
  return check.includes('\0')
}

function isMarkdownDiffFile(fileName: string | null): boolean {
  return fileName != null && /\.md$/iu.test(fileName)
}
