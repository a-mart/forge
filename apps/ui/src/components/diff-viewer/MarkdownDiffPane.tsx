import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { ChevronDown, Eye, EyeOff, FileText, ListTree } from 'lucide-react'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import { cn } from '@/lib/utils'
import { detectLanguage, highlightCode } from '@/lib/syntax-highlight'
import { useDiffTheme } from './diff-viewer-theme'
import { buildMarkdownDiffSections, type MarkdownDiffSection } from './markdown-diff-sections'
import '@/styles/syntax-highlight.css'
import './syntax-highlight.css'

type PreviewSource = 'new' | 'old'
type MarkdownDiffLayoutMode = 'full' | 'sidebar'

interface MarkdownDiffPaneProps {
  oldContent: string
  newContent: string
  fileName: string
  layoutMode?: MarkdownDiffLayoutMode
}

export function MarkdownDiffPane({
  oldContent,
  newContent,
  fileName,
  layoutMode = 'full',
}: MarkdownDiffPaneProps) {
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)
  const [expandAll, setExpandAll] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewSource, setPreviewSource] = useState<PreviewSource>('new')
  const [showOutline, setShowOutline] = useState(layoutMode === 'full')

  const { styles, useDarkTheme } = useDiffTheme()
  const language = useMemo(() => detectLanguage(fileName), [fileName])
  const { outlineSections, diffSections } = useMemo(
    () => buildMarkdownDiffSections(oldContent, newContent),
    [oldContent, newContent],
  )

  useEffect(() => {
    setSelectedSectionId(null)
    setExpandAll(false)
    setShowPreview(false)
    setPreviewSource('new')
    setShowOutline(layoutMode === 'full')
  }, [fileName, oldContent, newContent, layoutMode])

  useEffect(() => {
    if (selectedSectionId == null) {
      return
    }

    if (!diffSections.some((section) => section.id === selectedSectionId && !section.removed)) {
      setSelectedSectionId(null)
    }
  }, [diffSections, selectedSectionId])

  const renderContent = useMemo(() => {
    return (source: string): ReactElement => {
      const html = highlightCode(source, language)
      return <span dangerouslySetInnerHTML={{ __html: html }} />
    }
  }, [language])

  const selectedSection = selectedSectionId
    ? diffSections.find((section) => section.id === selectedSectionId && !section.removed) ?? null
    : null

  const visibleSections = useMemo(() => {
    if (selectedSection != null) {
      return [selectedSection]
    }

    if (expandAll) {
      return diffSections
    }

    return diffSections.filter((section) => section.hasChanges || section.removed)
  }, [diffSections, expandAll, selectedSection])

  const hiddenSectionCount = useMemo(
    () => diffSections.filter((section) => !section.removed && !section.hasChanges).length,
    [diffSections],
  )

  const previewContent = previewSource === 'new' ? newContent : oldContent
  const hasPreviewSwitch = oldContent.trim().length > 0 && newContent.trim().length > 0
  const isSidebarLayout = layoutMode === 'sidebar'

  return (
    <div className="syntax-highlight flex h-full flex-col overflow-hidden" data-layout={layoutMode}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
        <div className="ml-auto flex items-center gap-1">
          {selectedSection != null ? (
            <ToolbarButton onClick={() => setSelectedSectionId(null)} label="Show changed sections">
              Show changed
            </ToolbarButton>
          ) : null}
          <ToolbarButton
            onClick={() => setExpandAll((current) => !current)}
            label={expandAll ? 'Collapse unchanged sections' : 'Expand all sections'}
          >
            {expandAll ? 'Collapse unchanged' : 'Expand all'}
          </ToolbarButton>
          <ToolbarButton
            onClick={() => setShowPreview((current) => !current)}
            label={showPreview ? 'Hide preview' : 'Show preview'}
          >
            {showPreview ? (
              <>
                <EyeOff className="size-3.5" />
                Hide preview
              </>
            ) : (
              <>
                <Eye className="size-3.5" />
                Show preview
              </>
            )}
          </ToolbarButton>
        </div>
      </div>

      {isSidebarLayout ? (
        <div className="border-b border-border/60 bg-muted/10 px-3 py-2">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-background/70 px-2.5 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-expanded={showOutline}
            aria-controls="markdown-diff-inline-outline"
            onClick={() => setShowOutline((current) => !current)}
          >
            <span className="inline-flex items-center gap-1.5">
              <ListTree className="size-3.5" />
              Outline ({outlineSections.length})
            </span>
            <ChevronDown className={cn('size-3.5 transition-transform', showOutline && 'rotate-180')} />
          </button>
          {showOutline ? (
            <div id="markdown-diff-inline-outline" className="mt-2 space-y-1">
              {outlineSections.map((section) => {
                const matchingDiff = diffSections.find((entry) => entry.id === section.id)
                const isSelected = selectedSectionId === section.id
                const hasChanges = matchingDiff?.hasChanges ?? false
                return (
                  <OutlineButton
                    key={section.id}
                    sectionId={section.id}
                    title={section.title}
                    level={section.level}
                    isSelected={isSelected}
                    hasChanges={hasChanges}
                    onClick={() => setSelectedSectionId((current) => (current === section.id ? null : section.id))}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <div className={cn('flex h-full', showPreview && !isSidebarLayout && 'min-w-0')}>
          {!isSidebarLayout ? (
            <aside className="hidden w-60 shrink-0 border-r border-border/60 xl:flex xl:flex-col">
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <ListTree className="size-3.5" />
                Outline
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {outlineSections.map((section) => {
                  const matchingDiff = diffSections.find((entry) => entry.id === section.id)
                  const isSelected = selectedSectionId === section.id
                  const hasChanges = matchingDiff?.hasChanges ?? false
                  return (
                    <OutlineButton
                      key={section.id}
                      sectionId={section.id}
                      title={section.title}
                      level={section.level}
                      isSelected={isSelected}
                      hasChanges={hasChanges}
                      onClick={() => setSelectedSectionId((current) => (current === section.id ? null : section.id))}
                    />
                  )
                })}
              </div>
            </aside>
          ) : null}

          <div
            className={cn(
              'min-w-0 flex-1',
              showPreview ? (isSidebarLayout ? 'flex flex-col' : 'grid grid-cols-2') : 'flex',
            )}
          >
            <div className="min-h-0 overflow-auto">
              {selectedSection != null ? (
                <div className="border-b border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Showing section <span className="font-medium text-foreground">{selectedSection.title}</span>
                </div>
              ) : !expandAll && hiddenSectionCount > 0 ? (
                <div className="border-b border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Hiding {hiddenSectionCount} unchanged {hiddenSectionCount === 1 ? 'section' : 'sections'}
                </div>
              ) : null}

              {visibleSections.length > 0 ? (
                <div className="space-y-3 p-3">
                  {visibleSections.map((section) => {
                    const sectionExpanded = expandAll || selectedSection != null
                    return (
                      <MarkdownSectionCard
                        key={`${section.id}:${section.changeKind}:${sectionExpanded ? 'expanded' : 'collapsed'}`}
                        section={section}
                        renderContent={renderContent}
                        useDarkTheme={useDarkTheme}
                        styles={styles}
                        expandAll={sectionExpanded}
                      />
                    )
                  })}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                  <FileText className="mb-2 size-8 opacity-40" />
                  <span className="text-sm">No markdown changes to display</span>
                </div>
              )}
            </div>

            {showPreview ? (
              <div className={cn('min-h-0 overflow-hidden bg-muted/10', isSidebarLayout ? 'border-t border-border/60' : 'border-l border-border/60')}>
                <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                  <span>Rendered preview</span>
                  {hasPreviewSwitch ? (
                    <div className="inline-flex h-7 items-center rounded-md border border-border/60 bg-background/80 p-0.5">
                      <ToolbarToggle
                        active={previewSource === 'new'}
                        label="Preview current markdown"
                        onClick={() => setPreviewSource('new')}
                      >
                        Current
                      </ToolbarToggle>
                      <ToolbarToggle
                        active={previewSource === 'old'}
                        label="Preview previous markdown"
                        onClick={() => setPreviewSource('old')}
                      >
                        Previous
                      </ToolbarToggle>
                    </div>
                  ) : null}
                </div>
                <div className="h-full overflow-auto">
                  <div className={cn('mx-auto py-6', isSidebarLayout ? 'max-w-none px-4' : 'max-w-3xl px-8')}>
                    <MarkdownMessage content={previewContent} variant="document" enableMermaid />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function OutlineButton({
  title,
  level,
  isSelected,
  hasChanges,
  onClick,
}: {
  sectionId: string
  title: string
  level: number
  isSelected: boolean
  hasChanges: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onClick}
      className={cn(
        'mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors last:mb-0',
        isSelected
          ? 'bg-accent/80 text-foreground'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
      style={{ paddingLeft: `${Math.max(level - 1, 0) * 12 + 8}px` }}
    >
      <span
        className={cn('size-1.5 shrink-0 rounded-full', hasChanges ? 'bg-primary/80' : 'bg-muted-foreground/30')}
        aria-hidden
      />
      <span className="truncate">{title}</span>
    </button>
  )
}

function MarkdownSectionCard({
  section,
  renderContent,
  useDarkTheme,
  styles,
  expandAll,
}: {
  section: MarkdownDiffSection
  renderContent: (source: string) => ReactElement
  useDarkTheme: boolean
  styles: ReturnType<typeof useDiffTheme>['styles']
  expandAll: boolean
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground">{section.title}</h2>
          <p className="text-[11px] text-muted-foreground">
            {section.removed ? 'Removed section' : `Heading level ${section.level}`}
          </p>
        </div>
        <ChangeBadge section={section} />
      </div>
      <ReactDiffViewer
        oldValue={section.oldContent}
        newValue={section.newContent}
        splitView={false}
        useDarkTheme={useDarkTheme}
        styles={styles}
        compareMethod={DiffMethod.WORDS}
        extraLinesSurroundingDiff={expandAll ? 10000 : 1}
        showDiffOnly={!expandAll}
        renderContent={renderContent}
        codeFoldMessageRenderer={(totalLines: number) => (
          <span className="text-xs text-muted-foreground">Expand {totalLines} unchanged lines</span>
        )}
      />
    </section>
  )
}

function ChangeBadge({ section }: { section: MarkdownDiffSection }) {
  const classes = {
    added: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    modified: 'border-primary/25 bg-primary/10 text-primary',
    removed: 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-300',
    unchanged: 'border-border/70 bg-muted/40 text-muted-foreground',
  } as const

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        classes[section.changeKind],
      )}
    >
      {section.changeKind}
    </span>
  )
}

function ToolbarButton({
  children,
  onClick,
  label,
}: {
  children: ReactNode
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

function ToolbarToggle({
  children,
  active,
  onClick,
  label,
}: {
  children: ReactNode
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-[22px] rounded-[4px] px-2 text-[11px] font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}
