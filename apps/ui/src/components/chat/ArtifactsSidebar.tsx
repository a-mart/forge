import { createElement, useEffect, useState } from 'react'
import { Code2, Database, FileCode2, FileText, Image, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ArtifactReference } from '@/lib/artifacts'
import {
  categorizeArtifact,
  type ArtifactCategory,
} from '@/lib/collect-artifacts'
import { cn } from '@/lib/utils'
import { SchedulesPanel } from './SchedulesPanel'
import { useResizablePanel } from '@/components/diff-viewer/useResizablePanel'

export type ArtifactsSidebarTab = 'artifacts' | 'schedules'

interface ArtifactsSidebarProps {
  wsUrl: string
  managerId: string
  artifacts: ArtifactReference[]
  isOpen: boolean
  onClose: () => void
  onArtifactClick: (artifact: ArtifactReference) => void
  activeTab?: ArtifactsSidebarTab
  onActiveTabChange?: (tab: ArtifactsSidebarTab) => void
  panelMode?: 'tabs' | 'rail-selected'
  desktopPlacement?: 'left' | 'right'
  desktopOnly?: boolean
  mobileOnly?: boolean
}

function getCategoryIcon(category: ArtifactCategory) {
  switch (category) {
    case 'document':
      return FileText
    case 'code':
      return Code2
    case 'data':
      return Database
    case 'image':
      return Image
    case 'other':
      return FileCode2
  }
}

function getFileIcon(fileName: string) {
  const category = categorizeArtifact(fileName)
  return getCategoryIcon(category)
}

function truncatePath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path
  const segments = path.split('/')
  if (segments.length <= 3) return path

  const fileName = segments[segments.length - 1]
  const remaining = maxLength - fileName.length - 4 // account for .../
  if (remaining <= 0) return `…/${fileName}`

  let prefix = ''
  for (const seg of segments.slice(0, -1)) {
    if ((prefix + seg + '/').length > remaining) break
    prefix += `${seg}/`
  }

  return prefix ? `${prefix}…/${fileName}` : `…/${fileName}`
}

function isSidebarTab(value: string): value is ArtifactsSidebarTab {
  return value === 'artifacts' || value === 'schedules'
}

function getPanelTitle(activeTab: ArtifactsSidebarTab): string {
  return activeTab === 'schedules' ? 'Cron / Schedules' : 'Artifacts'
}

function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return true
    }
    return window.matchMedia('(min-width: 768px)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    const mediaQuery = window.matchMedia('(min-width: 768px)')
    const handleChange = () => setIsDesktop(mediaQuery.matches)
    handleChange()
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  return isDesktop
}

export function ArtifactsSidebar({
  wsUrl,
  managerId,
  artifacts,
  isOpen,
  onClose,
  onArtifactClick,
  activeTab: controlledTab,
  onActiveTabChange,
  panelMode = 'tabs',
  desktopPlacement = 'right',
  desktopOnly = false,
  mobileOnly = false,
}: ArtifactsSidebarProps) {
  const [internalTab, setInternalTab] = useState<ArtifactsSidebarTab>('artifacts')
  const activeTab = controlledTab ?? internalTab
  const isDesktopViewport = useIsDesktopViewport()
  const showTabs = panelMode !== 'rail-selected' || !isDesktopViewport
  const panelTitle = getPanelTitle(activeTab)
  const { width: paneWidth, isDragging, handleRef } = useResizablePanel({
    storageKey: 'forge-artifacts-schedules-pane-width',
    defaultWidth: 300,
    minWidth: 220,
    maxWidth: 520,
    invertDelta: desktopPlacement === 'right',
  })

  const handleTabChange = (tab: ArtifactsSidebarTab) => {
    if (onActiveTabChange) {
      onActiveTabChange(tab)
    } else {
      setInternalTab(tab)
    }
  }

  return (
    <>
      {isOpen && desktopPlacement === 'right' ? (
        <ArtifactsResizeHandle
          handleRef={handleRef}
          isDragging={isDragging}
          className={cn(desktopOnly && 'max-md:hidden', mobileOnly && 'md:hidden')}
        />
      ) : null}

      <div
        className={cn(
          'flex h-full shrink-0 flex-col bg-card/50',
          desktopPlacement === 'left' ? 'md:border-r md:border-border/80' : 'md:border-l md:border-border/80',
          'transition-[width,opacity] duration-200 ease-out',
          desktopOnly && 'max-md:hidden',
          mobileOnly && 'md:hidden',
          // Mobile: full screen overlay when open
          isOpen
            ? 'max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0 md:opacity-100'
            : 'w-0 opacity-0 overflow-hidden max-md:hidden',
          isOpen && 'opacity-100',
        )}
        style={isOpen ? { width: paneWidth } : undefined}
        aria-label="Artifacts panel"
        aria-hidden={!isOpen}
      >
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isSidebarTab(value)) {
            handleTabChange(value)
          }
        }}
        className="h-full gap-0"
      >
        <div className="flex h-[62px] shrink-0 items-center gap-2 px-3">
          {showTabs ? (
            <TabsList className="h-7 w-full bg-muted/60 p-0.5">
              <TabsTrigger
                value="artifacts"
                className="h-6 rounded-sm px-2.5 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                Artifacts
              </TabsTrigger>
              <TabsTrigger
                value="schedules"
                className="h-6 rounded-sm px-2.5 text-[11px] font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                Schedules
              </TabsTrigger>
            </TabsList>
          ) : (
            <h2 className="flex-1 truncate text-sm font-semibold text-foreground">
              {panelTitle}
            </h2>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
            onClick={onClose}
            aria-label="Close artifacts panel"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <TabsContent value="artifacts" className="mt-0 min-h-0 flex-1">
          <ScrollArea
            className={cn(
              'min-h-0 flex-1',
              '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
              '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
              'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
            )}
          >
            {artifacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                <FileText className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  No artifacts yet
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  Files and links from the conversation will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-0.5 p-2">
                {artifacts.map((artifact) => (
                  <ArtifactRow
                    key={artifact.path}
                    artifact={artifact}
                    onClick={onArtifactClick}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="schedules" className="mt-0 min-h-0 flex-1">
          <SchedulesPanel
            wsUrl={wsUrl}
            managerId={managerId}
            isActive={isOpen && activeTab === 'schedules'}
          />
        </TabsContent>
      </Tabs>
    </div>

      {isOpen && desktopPlacement === 'left' ? (
        <ArtifactsResizeHandle
          handleRef={handleRef}
          isDragging={isDragging}
          className={cn(desktopOnly && 'max-md:hidden', mobileOnly && 'md:hidden')}
        />
      ) : null}
    </>
  )
}

function ArtifactsResizeHandle({
  handleRef,
  isDragging,
  className,
}: {
  handleRef: (node: HTMLDivElement | null) => void
  isDragging: boolean
  className?: string
}) {
  return (
    <div
      ref={handleRef}
      className={cn(
        'group relative h-full shrink-0 cursor-col-resize transition-colors',
        isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border',
        className,
      )}
      style={{ width: 6 }}
    >
      <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
    </div>
  )
}

function ArtifactRow({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  const fileIcon = getFileIcon(artifact.fileName)
  const truncatedPath = truncatePath(artifact.path)

  return (
    <button
      type="button"
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        'transition-colors duration-100',
        'hover:bg-accent/70',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
      )}
      onClick={() => onClick(artifact)}
      title={artifact.path}
    >
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        {createElement(fileIcon, { className: 'size-3.5', 'aria-hidden': 'true' })}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">
          {artifact.fileName}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
          {truncatedPath}
        </span>
      </span>
    </button>
  )
}
