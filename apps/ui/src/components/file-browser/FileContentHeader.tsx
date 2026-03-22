import { Fragment, useCallback, useState } from 'react'
import {
  ChevronRight,
  Copy,
  Check,
  WrapText,
  ExternalLink,
  Eye,
  Code,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  readStoredEditorPreference,
  EDITOR_URL_SCHEMES,
  EDITOR_LABELS,
} from '@/lib/editor-preference'
import { toEditorHref } from '@/lib/artifacts'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface FileContentHeaderProps {
  filePath: string
  cwd: string
  wordWrap: boolean
  onToggleWordWrap: () => void
  onNavigateToDirectory: (dirPath: string) => void
  /** Whether the current file is a markdown file */
  isMarkdown?: boolean
  /** Whether markdown is showing raw source (true) or rendered preview (false) */
  markdownRaw?: boolean
  /** Toggle between raw source and rendered preview */
  onToggleMarkdownRaw?: () => void
}

export function FileContentHeader({
  filePath,
  cwd,
  wordWrap,
  onToggleWordWrap,
  onNavigateToDirectory,
  isMarkdown = false,
  markdownRaw = false,
  onToggleMarkdownRaw,
}: FileContentHeaderProps) {
  const [copied, setCopied] = useState(false)

  const segments = filePath.split('/')
  // Join cwd + relative path, normalizing any trailing/double slashes
  const absolutePath = [cwd.replace(/[\\/]+$/, ''), filePath].join('/')

  const editorPreference = readStoredEditorPreference()
  const editorScheme = EDITOR_URL_SCHEMES[editorPreference]
  const editorLabel = EDITOR_LABELS[editorPreference]

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(absolutePath)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard not available
    }
  }, [absolutePath])

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-card/50 px-3">
      {/* Breadcrumb navigation */}
      <nav
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs"
        aria-label="File path"
      >
        {segments.map((segment, i) => {
          const isLast = i === segments.length - 1
          const dirPath = segments.slice(0, i + 1).join('/')

          return (
            <Fragment key={dirPath}>
              {i > 0 && (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
              )}
              {isLast ? (
                <span className="truncate font-medium text-foreground">
                  {segment}
                </span>
              ) : (
                <button
                  type="button"
                  className="shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => onNavigateToDirectory(dirPath)}
                >
                  {segment}
                </button>
              )}
            </Fragment>
          )
        })}
      </nav>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5">
        <TooltipProvider delayDuration={300}>
          {/* Markdown preview/source toggle */}
          {isMarkdown && onToggleMarkdownRaw ? (
            <div className="mr-1 flex items-center rounded-md border border-border/50">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-l-[5px] px-2 text-[11px] transition-colors',
                      !markdownRaw
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={markdownRaw ? onToggleMarkdownRaw : undefined}
                    aria-label="Preview"
                  >
                    <Eye className="size-3" />
                    <span>Preview</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  Rendered markdown
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-r-[5px] px-2 text-[11px] transition-colors',
                      markdownRaw
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={markdownRaw ? undefined : onToggleMarkdownRaw}
                    aria-label="Source"
                  >
                    <Code className="size-3" />
                    <span>Source</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  Raw source
                </TooltipContent>
              </Tooltip>
            </div>
          ) : null}

          {/* Copy path */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
                onClick={handleCopyPath}
                aria-label="Copy file path"
              >
                {copied ? (
                  <Check className="size-3.5 text-green-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {copied ? 'Copied!' : 'Copy path'}
            </TooltipContent>
          </Tooltip>

          {/* Word wrap toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md transition-colors',
                  wordWrap
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                onClick={onToggleWordWrap}
                aria-label={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
              >
                <WrapText className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
            </TooltipContent>
          </Tooltip>

          {/* Open in editor */}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={toEditorHref(absolutePath, editorScheme)}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
                aria-label={`Open in ${editorLabel}`}
              >
                <ExternalLink className="size-3" />
                <span className="hidden lg:inline">{editorLabel}</span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              Open in {editorLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
