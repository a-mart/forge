import { formatFileSize } from './file-browser-utils'

interface FileStatusBarProps {
  fileCount: number | null
  fileCountMethod: string | null
  selectedFile: string | null
  languageDisplayName?: string | undefined
  lineCount?: number | null
  fileSize?: number | null
}

export function FileStatusBar({
  fileCount,
  fileCountMethod,
  selectedFile,
  languageDisplayName,
  lineCount,
  fileSize,
}: FileStatusBarProps) {
  const hasFileInfo = selectedFile && (languageDisplayName || lineCount != null || fileSize != null)

  return (
    <div
      className="flex h-7 shrink-0 items-center border-t border-border/60 bg-card/80 px-3 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {hasFileInfo ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground/60">UTF-8</span>
          {languageDisplayName && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span>{languageDisplayName}</span>
            </>
          )}
          {lineCount != null && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span>{lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'}</span>
            </>
          )}
          {fileSize != null && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span>{formatFileSize(fileSize)}</span>
            </>
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
