import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  CircleHelp,
  Copy,
  Edit3,
  FolderOpen,
  EyeOff,
  GitFork,
  History,
  Loader2,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  X,
  Pin,
  Zap,
  CheckCheck,
} from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ChangeCwdDialog } from './ChangeCwdDialog'
import { ForkSessionDialog } from './ForkSessionDialog'
import { SidebarUsageRings, SidebarUsagePanel } from './SidebarUsageWidget'
import { SpecialistBadge } from './SpecialistBadge'
import { useHelp } from '@/components/help/help-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  buildProfileTreeRows,
  isCortexProfile,
  isSessionRunning,
  type ProfileTreeRow,
  type SessionRow,
} from '@/lib/agent-hierarchy'
import { inferModelPreset, useModelPresets } from '@/lib/model-preset'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { useProviderUsage } from '@/hooks/use-provider-usage'
import { readSidebarModelIconsPref, readSidebarProviderUsagePref } from '@/lib/sidebar-prefs'
import { cn } from '@/lib/utils'
import {
  MANAGER_REASONING_LEVELS,
  getChangeManagerFamilies,
  type AgentContextUsage,
  type AgentDescriptor,
  type AgentStatus,
  type ManagerModelPreset,
  type ManagerReasoningLevel,
  type ManagerProfile,
  type ProjectAgentInfo,
} from '@forge/protocol'

interface AgentSidebarProps {
  connected: boolean
  wsUrl?: string
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  unreadCounts: Record<string, number>
  terminalScopeId?: string | null
  terminalCount?: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isPlaywrightActive?: boolean
  isStatsActive?: boolean
  showPlaywrightNav?: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onOpenCortexReview?: (agentId: string) => void
  onOpenPlaywright?: () => void
  onOpenStats?: () => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onRenameSession?: (agentId: string, label: string) => void
  onPinSession?: (agentId: string, pinned: boolean) => void
  onRenameProfile?: (profileId: string, displayName: string) => void
  onForkSession?: (sourceAgentId: string, name?: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onUpdateManagerModel?: (managerId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => void
  onUpdateManagerCwd?: (managerId: string, cwd: string) => Promise<void>
  onBrowseDirectory?: (defaultPath: string) => Promise<string | null>
  onValidateDirectory?: (path: string) => Promise<import('@/lib/ws-client').DirectoryValidationResult>
  onRequestSessionWorkers?: (sessionId: string) => void
  onReorderProfiles?: (profileIds: string[]) => void
  onSetSessionProjectAgent?: (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string } | null) => Promise<void>
  onGetProjectAgentConfig?: (agentId: string) => Promise<{ agentId: string; config: import('@forge/protocol').PersistedProjectAgentConfig; systemPrompt: string | null; references: string[] }>
  onListProjectAgentReferences?: (agentId: string) => Promise<{ agentId: string; references: string[] }>
  onGetProjectAgentReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string; content: string }>
  onSetProjectAgentReference?: (agentId: string, fileName: string, content: string) => Promise<{ agentId: string; fileName: string }>
  onDeleteProjectAgentReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string }>
  onRequestProjectAgentRecommendations?: (agentId: string) => Promise<{ whenToUse: string; systemPrompt: string }>
  onCreateAgentCreator?: (profileId: string) => void
}

type AgentLiveStatus = {
  status: AgentStatus
  pendingCount: number
}

interface CortexScanBadgeResponse {
  scan?: {
    summary?: {
      needsReview?: number
    }
  }
}

function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>,
): AgentLiveStatus {
  const live = statuses[agent.agentId]
  return {
    status: live?.status ?? agent.status,
    pendingCount: live?.pendingCount ?? 0,
  }
}

// Inject subtle glow pulse keyframes once
if (typeof document !== 'undefined' && !document.getElementById('sidebar-glow-pulse')) {
  const style = document.createElement('style')
  style.id = 'sidebar-glow-pulse'
  style.textContent = `@keyframes subtle-glow-pulse{0%,100%{box-shadow:0 0 6px rgba(245,158,11,0.5)}50%{box-shadow:0 0 10px rgba(245,158,11,0.7)}}`
  document.head.appendChild(style)
}

// ── Shared components ──

function HelpButton() {
  const { isDrawerOpen, openDrawer } = useHelp()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openDrawer('chat.main')}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
            isDrawerOpen
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
          )}
          aria-label="Help"
          aria-pressed={isDrawerOpen}
          data-tour="help-button"
        >
          <CircleHelp aria-hidden="true" className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>Help (Ctrl+/)</TooltipContent>
    </Tooltip>
  )
}

function SessionStatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
      )}
      aria-label={running ? 'Running' : 'Idle'}
    />
  )
}

function SidebarModelIcon({ agent }: { agent: AgentDescriptor }) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-opus' || provider.includes('anthropic') || provider.includes('claude')) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain opacity-70" />
  }

  if (preset === 'pi-codex' || preset === 'pi-5.4' || preset === 'codex-app' || provider.includes('openai')) {
    return <img src="/agents/codex-logo.svg" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain opacity-70 dark:invert" />
  }

  return <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" aria-hidden="true" />
}

function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}





// ── Search helpers ──

function parseSearchQuery(raw: string): { mode: 'both' | 'session' | 'worker'; term: string } {
  const trimmed = raw.trim()
  if (trimmed.startsWith('s:')) return { mode: 'session', term: trimmed.slice(2).trim() }
  if (trimmed.startsWith('w:')) return { mode: 'worker', term: trimmed.slice(2).trim() }
  return { mode: 'both', term: trimmed }
}

function getSessionLabel(session: SessionRow): string {
  return session.sessionAgent.sessionLabel || (session.isDefault ? 'Main' : session.sessionAgent.displayName || session.sessionAgent.agentId)
}

function filterTreeRows(
  rows: ProfileTreeRow[],
  rawQuery: string,
): { filtered: ProfileTreeRow[]; matchCount: number } {
  const { mode, term } = parseSearchQuery(rawQuery)
  if (!term) return { filtered: rows, matchCount: 0 }

  const lowerTerm = term.toLowerCase()
  let matchCount = 0
  const filtered: ProfileTreeRow[] = []

  for (const row of rows) {
    const matchingSessions: SessionRow[] = []

    for (const session of row.sessions) {
      const sessionLabel = getSessionLabel(session).toLowerCase()
      const sessionAgentId = session.sessionAgent.agentId.toLowerCase()
      const sessionDisplayName = (session.sessionAgent.displayName || '').toLowerCase()
      const sessionMatches = (mode === 'both' || mode === 'session') &&
        (sessionLabel.includes(lowerTerm) || sessionAgentId.includes(lowerTerm) || sessionDisplayName.includes(lowerTerm))

      const workerMatches = (mode === 'both' || mode === 'worker') &&
        session.workers.some(
          (w) => (w.displayName || w.agentId).toLowerCase().includes(lowerTerm),
        )

      if (sessionMatches || workerMatches) {
        matchingSessions.push(session)
        matchCount++
      }
    }

    if (matchingSessions.length > 0) {
      filtered.push({ ...row, sessions: matchingSessions })
    }
  }

  return { filtered, matchCount }
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let lastIndex = 0

  let searchFrom = 0
  while (searchFrom < lowerText.length) {
    const index = lowerText.indexOf(lowerQuery, searchFrom)
    if (index === -1) break

    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index))
    }
    parts.push(
      <span key={index} className="rounded-sm bg-yellow-500/20">
        {text.slice(index, index + query.length)}
      </span>,
    )
    lastIndex = index + query.length
    searchFrom = lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}

// ── Worker row (unchanged from original pattern) ──

function WorkerRow({
  agent,
  liveStatus,
  isSelected,
  onSelect,
  onDelete,
  onStop,
  onResume,
  highlightQuery,
}: {
  agent: AgentDescriptor
  liveStatus: AgentLiveStatus
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
  onStop?: () => void
  onResume?: () => void
  highlightQuery?: string
}) {
  const name = agent.displayName || agent.agentId
  const tooltipLines = [
    name,
    `${agent.model.provider}/${agent.model.modelId}`,
    ...(agent.model.thinkingLevel ? [`reasoning: ${agent.model.thinkingLevel}`] : []),
  ]
  const isActive = liveStatus.status === 'streaming'
  const isRunning = liveStatus.status === 'streaming' || liveStatus.status === 'idle'
  const isStopped = liveStatus.status === 'terminated' || liveStatus.status === 'stopped'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex w-full items-center gap-1 rounded-md py-1.5 pl-12 pr-1.5 transition-colors',
            isSelected
              ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
              : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onSelect}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
                >
                  <span
                    className={cn(
                      'inline-block size-1.5 shrink-0 rounded-full',
                      isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                    aria-label={isActive ? 'Active' : 'Idle'}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm leading-5">
                    {highlightQuery ? <HighlightedText text={name} query={highlightQuery} /> : name}
                  </span>
                  {agent.specialistId && agent.specialistDisplayName && agent.specialistColor ? (
                    <SpecialistBadge
                      displayName={agent.specialistDisplayName}
                      color={agent.specialistColor}
                      className="shrink-0"
                    />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
                {tooltipLines.map((line, i) => (
                  <p key={i} className={i === 0 ? 'font-medium' : 'opacity-80'}>{line}</p>
                ))}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {isRunning && onStop ? (
          <ContextMenuItem onClick={onStop}>
            <Pause className="mr-2 size-3.5" />
            Stop
          </ContextMenuItem>
        ) : null}
        {isStopped && onResume ? (
          <ContextMenuItem onClick={onResume}>
            <Play className="mr-2 size-3.5" />
            Resume
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="mr-2 size-3.5" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ── Session row ──

function SessionRowItem({
  session,
  statuses,
  unreadCount,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  isWorkerListExpanded,
  onToggleCollapse,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onStop,
  onResume,
  onDelete,
  onRename,
  onFork,
  onMarkUnread,
  onStopWorker,
  onResumeWorker,
  highlightQuery,
  onPinSession,
  onPromoteToProjectAgent,
  onOpenProjectAgentSettings,
  onDemoteProjectAgent,
  onViewCreationHistory,
}: {
  session: SessionRow
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  unreadCount: number
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  isWorkerListExpanded: boolean
  onToggleCollapse: () => void
  onToggleWorkerListExpanded: () => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onStop?: () => void
  onResume?: () => void
  onDelete?: () => void
  onRename?: () => void
  onFork?: () => void
  onMarkUnread?: () => void
  onStopWorker?: (agentId: string) => void
  onResumeWorker?: (agentId: string) => void
  highlightQuery?: string
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: () => void
  onOpenProjectAgentSettings?: () => void
  onDemoteProjectAgent?: () => void
  onViewCreationHistory?: () => void
}) {
  const { sessionAgent, workers, isDefault } = session
  const running = isSessionRunning(sessionAgent)
  const isSelected = !isSettingsActive && selectedAgentId === sessionAgent.agentId
  const label = sessionAgent.sessionLabel || (isDefault ? 'Main' : sessionAgent.displayName || sessionAgent.agentId)
  const workerCount = session.sessionAgent.workerCount ?? workers.length
  const hasWorkers = workerCount > 0
  const showUnread = unreadCount > 0
  const streamingWorkerCount = workers.filter((w) => getAgentLiveStatus(w, statuses).status === 'streaming').length
    || sessionAgent.activeWorkerCount
    || 0
  const managerStreaming = getAgentLiveStatus(sessionAgent, statuses).status === 'streaming'
  const hasPendingChoice = (sessionAgent.pendingChoiceCount ?? 0) > 0
  const isProjectAgent = Boolean(sessionAgent.projectAgent)
  const isAgentCreator = sessionAgent.sessionPurpose === 'agent_creator'
  const isPinned = Boolean(sessionAgent.pinnedAt)

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'relative flex items-center rounded-md transition-colors',
              isSelected
                ? 'bg-white/[0.04] text-sidebar-foreground ring-1 ring-sidebar-ring/30'
                : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
            )}
          >
            {/* Expand/collapse toggle (only show if has workers) */}
            {hasWorkers ? (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} session workers`}
                aria-expanded={!isCollapsed}
                className={cn(
                  'absolute left-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                  'hover:text-sidebar-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                )}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-3" aria-hidden="true" />
                )}
              </button>
            ) : null}

            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(sessionAgent.agentId)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1.5 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      hasWorkers ? 'pl-7' : 'pl-5',
                    )}
                  >
                    {streamingWorkerCount > 0 ? (
                      <span
                        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-amber-500 bg-transparent"
                        style={{ animation: 'subtle-glow-pulse 2s ease-in-out infinite' }}
                        aria-label={`${streamingWorkerCount} worker${streamingWorkerCount !== 1 ? 's' : ''} active`}
                      >
                        <span className="text-[8px] font-bold leading-none text-amber-500">
                          {streamingWorkerCount}
                        </span>
                      </span>
                    ) : hasPendingChoice ? (
                      <span
                        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-blue-400 bg-transparent"
                        style={{ boxShadow: '0 0 6px rgba(96,165,250,0.5)' }}
                        aria-label="Awaiting your response"
                      >
                        <span className="text-[8px] font-bold leading-none text-blue-400">?</span>
                      </span>
                    ) : managerStreaming ? (
                      <span
                        className="inline-flex size-3 shrink-0 rounded-full border-2 border-amber-500 bg-transparent"
                        style={{ animation: 'subtle-glow-pulse 2s ease-in-out infinite' }}
                        aria-label="Manager streaming"
                      />
                    ) : isAgentCreator ? (
                      <Sparkles className="size-3 shrink-0 text-violet-400" aria-label="Agent Creator" />
                    ) : (
                      <SessionStatusDot running={running} />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm leading-5">
                      {highlightQuery ? <HighlightedText text={label} query={highlightQuery} /> : label}
                    </span>
                    {isPinned && !isProjectAgent && sessionAgent.profileId ? (
                      <Pin className="size-3 shrink-0 text-muted-foreground/60" aria-label="Pinned" />
                    ) : null}
                    {isProjectAgent ? (
                      <Zap className="size-3 shrink-0 text-blue-400 dark:text-blue-400" aria-label="Project Agent" />
                    ) : null}
                    {hasPendingChoice ? (
                      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white">
                        ?
                      </span>
                    ) : showUnread ? (
                      <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6} className="px-2 py-1 text-[10px]">
                  <p className="font-medium">{label}</p>
                  <p className="opacity-80">{sessionAgent.model.provider}/{sessionAgent.model.modelId}</p>
                  {sessionAgent.model.thinkingLevel ? (
                    <p className="opacity-80">reasoning: {sessionAgent.model.thinkingLevel}</p>
                  ) : null}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              const sessionDir = sessionAgent.sessionFile.replace(/\/[^/]+$/, '')
              navigator.clipboard.writeText(sessionDir)
            }}
          >
            <Copy className="mr-2 size-3.5" />
            Copy path
          </ContextMenuItem>
          {onPinSession && sessionAgent.profileId ? (
            <ContextMenuItem onClick={() => onPinSession(sessionAgent.agentId, !isPinned)}>
              <Pin className="mr-2 size-3.5" />
              {isPinned ? 'Unpin' : 'Pin'}
            </ContextMenuItem>
          ) : null}
          {onRename ? (
            <ContextMenuItem onClick={onRename}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onFork ? (
            <ContextMenuItem onClick={onFork}>
              <GitFork className="mr-2 size-3.5" />
              Fork
            </ContextMenuItem>
          ) : null}
          {running && onStop ? (
            <ContextMenuItem onClick={onStop}>
              <Pause className="mr-2 size-3.5" />
              Stop
            </ContextMenuItem>
          ) : null}
          {!running && onResume ? (
            <ContextMenuItem onClick={onResume}>
              <Play className="mr-2 size-3.5" />
              Resume
            </ContextMenuItem>
          ) : null}
          {onMarkUnread ? (
            <ContextMenuItem onClick={onMarkUnread}>
              <EyeOff className="mr-2 size-3.5" />
              Mark as unread
            </ContextMenuItem>
          ) : null}
          {onPromoteToProjectAgent && !isProjectAgent ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onPromoteToProjectAgent}>
                <ArrowUpFromLine className="mr-2 size-3.5" />
                Promote to Project Agent
              </ContextMenuItem>
            </>
          ) : null}
          {isProjectAgent && onOpenProjectAgentSettings ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onOpenProjectAgentSettings}>
                <Settings className="mr-2 size-3.5" />
                Project Agent Settings
              </ContextMenuItem>
            </>
          ) : null}
          {isProjectAgent && onViewCreationHistory ? (
            <ContextMenuItem onClick={onViewCreationHistory}>
              <History className="mr-2 size-3.5" />
              View Creation History
            </ContextMenuItem>
          ) : null}
          {isProjectAgent && onDemoteProjectAgent ? (
            <ContextMenuItem onClick={onDemoteProjectAgent}>
              <ArrowDownToLine className="mr-2 size-3.5" />
              Demote to Session
            </ContextMenuItem>
          ) : null}
          {!isDefault && onDelete ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Workers nested under session */}
      {hasWorkers && !isCollapsed ? (
        <div className="relative mt-0.5">
          {(() => {
            const needsWorkerTruncation = workers.length > MAX_VISIBLE_WORKERS
            let visibleWorkers: AgentDescriptor[]
            let hiddenWorkerCount = 0

            if (isWorkerListExpanded || !needsWorkerTruncation) {
              visibleWorkers = workers
            } else {
              const topWorkers = workers.slice(0, MAX_VISIBLE_WORKERS)
              const selectedWorkerInTop = !selectedAgentId || isSettingsActive || topWorkers.some(
                (w) => w.agentId === selectedAgentId,
              )

              if (selectedWorkerInTop) {
                visibleWorkers = topWorkers
              } else {
                const selectedWorker = workers.find((w) => w.agentId === selectedAgentId)
                if (selectedWorker) {
                  visibleWorkers = [...topWorkers.slice(0, MAX_VISIBLE_WORKERS - 1), selectedWorker]
                } else {
                  visibleWorkers = topWorkers
                }
              }
              hiddenWorkerCount = workers.length - visibleWorkers.length
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {visibleWorkers.map((worker) => {
                    const workerLiveStatus = getAgentLiveStatus(worker, statuses)
                    const workerIsSelected = !isSettingsActive && selectedAgentId === worker.agentId

                    return (
                      <li key={worker.agentId}>
                        <WorkerRow
                          agent={worker}
                          liveStatus={workerLiveStatus}
                          isSelected={workerIsSelected}
                          onSelect={() => onSelect(worker.agentId)}
                          onDelete={() => onDeleteAgent(worker.agentId)}
                          onStop={onStopWorker ? () => onStopWorker(worker.agentId) : undefined}
                          onResume={onResumeWorker ? () => onResumeWorker(worker.agentId) : undefined}
                          highlightQuery={highlightQuery}
                        />
                      </li>
                    )
                  })}
                </ul>
                {needsWorkerTruncation ? (
                  <button
                    type="button"
                    onClick={onToggleWorkerListExpanded}
                    className={cn(
                      'relative z-10 mt-0.5 flex w-full items-center gap-1 rounded-md py-1 pl-12 pr-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors',
                      'hover:text-muted-foreground hover:bg-sidebar-accent/30',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    )}
                  >
                    {isWorkerListExpanded ? (
                      <>
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenWorkerCount} more</span>
                      </>
                    )}
                  </button>
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </li>
  )
}

// ── Profile group ──

const MAX_VISIBLE_SESSIONS = 8
const SESSION_PAGE_SIZE = 15
const MAX_VISIBLE_WORKERS = 15

function ProfileGroup({
  treeRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  collapsedSessionIds,
  visibleSessionLimit,
  expandedWorkerListSessionIds,
  onToggleProfileCollapsed,
  onToggleSessionCollapsed,
  onShowMoreSessions,
  onShowLessSessions,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onDeleteManager,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRequestRenameSession,
  onRequestRenameProfile,
  onForkSession,
  onMarkUnread,
  onMarkAllRead,
  onChangeModel,
  onChangeCwd,
  showModelIcons,
  highlightQuery,
  dragHandleRef,
  dragHandleListeners,
  onPinSession,
  onPromoteToProjectAgent,
  onOpenProjectAgentSettings,
  onDemoteProjectAgent,
  onCreateAgentCreator,
}: {
  treeRow: ProfileTreeRow
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  collapsedSessionIds: Set<string>
  visibleSessionLimit: number
  expandedWorkerListSessionIds: Set<string>
  onToggleProfileCollapsed: () => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onShowMoreSessions: () => void
  onShowLessSessions: () => void
  onToggleWorkerListExpanded: (sessionId: string) => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onRequestRenameSession?: (agentId: string) => void
  onRequestRenameProfile?: (profileId: string) => void
  onForkSession?: (sourceAgentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onChangeModel?: (profileId: string) => void
  onChangeCwd?: (profileId: string) => void
  showModelIcons?: boolean
  highlightQuery?: string
  dragHandleRef?: (element: HTMLElement | null) => void
  dragHandleListeners?: Record<string, any> | undefined
  onPinSession?: (agentId: string, pinned: boolean) => void
  onPromoteToProjectAgent?: (agentId: string) => void
  onOpenProjectAgentSettings?: (agentId: string) => void
  onDemoteProjectAgent?: (agentId: string) => void | Promise<void>
  onCreateAgentCreator?: (profileId: string) => void
}) {
  const { profile, sessions } = treeRow
  const hasAnySessions = sessions.length > 0
  const defaultSession = sessions.find((s) => s.isDefault)

  // Profile summary for tooltip
  const representativeAgent = defaultSession?.sessionAgent ?? sessions[0]?.sessionAgent

  const profileTooltipLines: string[] = []
  if (sessions.length > 0) {
    profileTooltipLines.push(`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`)
  }
  if (representativeAgent) {
    profileTooltipLines.push(`${representativeAgent.model.provider}/${representativeAgent.model.modelId}`)
    if (representativeAgent.model.thinkingLevel) {
      profileTooltipLines.push(`reasoning: ${representativeAgent.model.thinkingLevel}`)
    }
  }

  return (
    <>
      {/* Profile header */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex items-center rounded-lg border border-white/[0.04] bg-white/[0.03]">
            <button
              type="button"
              onClick={onToggleProfileCollapsed}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${profile.displayName}`}
              aria-expanded={!isCollapsed}
              className={cn(
                'group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                'hover:text-sidebar-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
              )}
            >
              {isCollapsed ? (
                <ChevronRight className="size-3" aria-hidden="true" />
              ) : (
                <ChevronDown className="size-3" aria-hidden="true" />
              )}
            </button>

            <TooltipProvider delayDuration={400}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    ref={dragHandleRef}
                    {...dragHandleListeners}
                    onClick={() => {
                      // Click profile header → select default session
                      const targetId = sessions[0]?.sessionAgent.agentId
                      if (targetId) onSelect(targetId)
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-5.5 pr-1.5 text-left transition-colors',
                      'hover:bg-sidebar-accent/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      dragHandleListeners ? 'cursor-grab active:cursor-grabbing' : '',
                    )}
                    style={dragHandleListeners ? { touchAction: 'none' } : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                      {profile.displayName}
                    </span>
                    {showModelIcons && representativeAgent ? (
                      <span className="ml-1 shrink-0">
                        <SidebarModelIcon agent={representativeAgent} />
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                {profileTooltipLines.length > 0 ? (
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    {profileTooltipLines.map((line, i) => (
                      <p key={i} className={i === 0 ? 'font-medium' : 'opacity-80'}>{line}</p>
                    ))}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            </TooltipProvider>

            {/* Inline "new session" button on profile header */}
            {onCreateSession ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCreateSession(profile.profileId)
                      }}
                      className={cn(
                        'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition',
                        'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                      aria-label={`New session for ${profile.displayName}`}
                    >
                      <Plus className="size-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    New session
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {onCreateSession ? (
            <ContextMenuItem onClick={() => onCreateSession(profile.profileId)}>
              <Plus className="mr-2 size-3.5" />
              New Session
            </ContextMenuItem>
          ) : null}
          {onRequestRenameProfile ? (
            <ContextMenuItem onClick={() => onRequestRenameProfile(profile.profileId)}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onChangeModel ? (
            <ContextMenuItem onClick={() => onChangeModel(profile.profileId)}>
              <RefreshCw className="mr-2 size-3.5" />
              Change Model
            </ContextMenuItem>
          ) : null}
          {onChangeCwd && !isCortexProfile(treeRow) ? (
            <ContextMenuItem onClick={() => onChangeCwd(profile.profileId)}>
              <FolderOpen className="mr-2 size-3.5" />
              Change Working Directory
            </ContextMenuItem>
          ) : null}
          {onCreateAgentCreator ? (
            <ContextMenuItem onClick={() => onCreateAgentCreator(profile.profileId)}>
              <Sparkles className="mr-2 size-3.5" />
              Create Project Agent
            </ContextMenuItem>
          ) : null}
          {onMarkAllRead && sessions.some((s) => (unreadCounts[s.sessionAgent.agentId] ?? 0) > 0) ? (
            <ContextMenuItem onClick={() => onMarkAllRead(profile.profileId)}>
              <CheckCheck className="mr-2 size-3.5" />
              Mark All as Read
            </ContextMenuItem>
          ) : null}
          {!isCortexProfile(treeRow) ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => onDeleteManager(profile.profileId)}>
                <Trash2 className="mr-2 size-3.5" />
                Delete Manager
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Sessions list */}
      {!isCollapsed && hasAnySessions ? (
        <div className="relative mt-1">
          {(() => {
            // Build a set of all session agentIds in this profile for existence checks
            const sessionAgentIds = new Set(sessions.map((s) => s.sessionAgent.agentId))

            // Hide completed wizard sessions (agentCreatorResult is set) — always hidden
            const isCompletedWizard = (s: SessionRow) =>
              Boolean(s.sessionAgent.agentCreatorResult)

            // Split sessions into project agents (always visible) and regular sessions (subject to truncation)
            const projectAgentSessions = sessions.filter((s) => Boolean(s.sessionAgent.projectAgent))
            const pinnedSessions = sessions.filter((s) =>
              !s.sessionAgent.projectAgent &&
              Boolean(s.sessionAgent.pinnedAt) &&
              !isCompletedWizard(s)
            ).sort((a, b) => {
              const aPinned = a.sessionAgent.pinnedAt ?? ''
              const bPinned = b.sessionAgent.pinnedAt ?? ''
              return aPinned.localeCompare(bPinned)
            })
            const regularSessions = sessions.filter((s) =>
              !s.sessionAgent.projectAgent &&
              !s.sessionAgent.pinnedAt &&
              !isCompletedWizard(s)
            )

            const hasMore = regularSessions.length > visibleSessionLimit
            const isExpanded = visibleSessionLimit > MAX_VISIBLE_SESSIONS
            let visibleRegularSessions: SessionRow[]
            let hiddenCount = 0

            if (!hasMore) {
              visibleRegularSessions = regularSessions
            } else {
              // Take the top visibleSessionLimit, but guarantee the selected session is visible
              const topSessions = regularSessions.slice(0, visibleSessionLimit)
              const selectedSessionInTop = !selectedAgentId || isSettingsActive || topSessions.some(
                (s) =>
                  s.sessionAgent.agentId === selectedAgentId ||
                  s.workers.some((w) => w.agentId === selectedAgentId),
              )

              if (selectedSessionInTop) {
                visibleRegularSessions = topSessions
              } else {
                const selectedSession = regularSessions.find(
                  (s) =>
                    s.sessionAgent.agentId === selectedAgentId ||
                    s.workers.some((w) => w.agentId === selectedAgentId),
                )
                if (selectedSession) {
                  visibleRegularSessions = [...topSessions.slice(0, visibleSessionLimit - 1), selectedSession]
                } else {
                  visibleRegularSessions = topSessions
                }
              }
              hiddenCount = regularSessions.length - visibleRegularSessions.length
            }

            // Determine if a session is eligible for project agent promotion
            // Cortex sessions and cortex_review sessions are excluded
            const isCortex = sessions.some((s) => s.sessionAgent.archetypeId === 'cortex')
            const canPromote = (s: SessionRow) =>
              !isCortex &&
              s.sessionAgent.sessionPurpose !== 'cortex_review' &&
              s.sessionAgent.sessionPurpose !== 'agent_creator' &&
              !s.sessionAgent.projectAgent

            const renderSession = (session: SessionRow) => {
              const sessionCollapsed = !collapsedSessionIds.has(session.sessionAgent.agentId)
              const eligible = canPromote(session)

              return (
                <SessionRowItem
                  key={session.sessionAgent.agentId}
                  session={session}
                  statuses={statuses}
                  unreadCount={unreadCounts[session.sessionAgent.agentId] ?? 0}
                  selectedAgentId={selectedAgentId}
                  isSettingsActive={isSettingsActive}
                  isCollapsed={sessionCollapsed}
                  isWorkerListExpanded={expandedWorkerListSessionIds.has(session.sessionAgent.agentId)}
                  onToggleCollapse={() => onToggleSessionCollapsed(session.sessionAgent.agentId)}
                  onToggleWorkerListExpanded={() => onToggleWorkerListExpanded(session.sessionAgent.agentId)}
                  onSelect={onSelect}
                  onDeleteAgent={onDeleteAgent}
                  onStop={onStopSession ? () => onStopSession(session.sessionAgent.agentId) : undefined}
                  onResume={onResumeSession ? () => onResumeSession(session.sessionAgent.agentId) : undefined}
                  onDelete={onDeleteSession ? () => onDeleteSession(session.sessionAgent.agentId) : undefined}
                  onRename={onRequestRenameSession ? () => onRequestRenameSession(session.sessionAgent.agentId) : undefined}
                  onFork={onForkSession && session.sessionAgent.sessionPurpose !== 'agent_creator' ? () => onForkSession(session.sessionAgent.agentId) : undefined}
                  onMarkUnread={onMarkUnread ? () => onMarkUnread(session.sessionAgent.agentId) : undefined}
                  onStopWorker={onStopSession}
                  onResumeWorker={onResumeSession}
                  highlightQuery={highlightQuery}
                  onPinSession={onPinSession}
                  onPromoteToProjectAgent={eligible && onPromoteToProjectAgent ? () => onPromoteToProjectAgent(session.sessionAgent.agentId) : undefined}
                  onOpenProjectAgentSettings={session.sessionAgent.projectAgent && onOpenProjectAgentSettings ? () => onOpenProjectAgentSettings(session.sessionAgent.agentId) : undefined}
                  onDemoteProjectAgent={session.sessionAgent.projectAgent && onDemoteProjectAgent ? async () => {
                    try {
                      await onDemoteProjectAgent(session.sessionAgent.agentId)
                    } catch (err) {
                      console.error('Failed to demote project agent:', err)
                    }
                  } : undefined}
                  onViewCreationHistory={
                    session.sessionAgent.projectAgent?.creatorSessionId &&
                    sessionAgentIds.has(session.sessionAgent.projectAgent.creatorSessionId)
                      ? () => onSelect(session.sessionAgent.projectAgent!.creatorSessionId!)
                      : undefined
                  }
                />
              )
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {/* Project agents always pinned at top */}
                  {projectAgentSessions.map(renderSession)}
                  {/* Pinned sessions always visible, sorted by pin time */}
                  {pinnedSessions.map(renderSession)}
                  {/* Regular sessions below */}
                  {visibleRegularSessions.map(renderSession)}
                </ul>
                {hasMore || isExpanded ? (
                  <div className="relative z-10 mt-0.5 flex items-center gap-2 pl-5 pr-1.5">
                    {hasMore ? (
                      <button
                        type="button"
                        onClick={onShowMoreSessions}
                        className={cn(
                          'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-muted-foreground/70 transition-colors',
                          'hover:text-muted-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        )}
                      >
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenCount} more</span>
                      </button>
                    ) : null}
                    {isExpanded ? (
                      <button
                        type="button"
                        onClick={onShowLessSessions}
                        className={cn(
                          'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-muted-foreground/70 transition-colors',
                          'hover:text-muted-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        )}
                      >
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </>
  )
}

// ── Create session dialog ──

function CreateSessionDialog({
  profileId,
  profileLabel,
  onConfirm,
  onClose,
}: {
  profileId: string
  profileLabel: string
  onConfirm: (profileId: string, name?: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')

  const trimmedName = name.trim()
  const slugPreview = slugifySessionName(trimmedName)
  const showInvalidSlugWarning = trimmedName.length > 0 && slugPreview.length === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onConfirm(profileId, trimmedName.length > 0 ? trimmedName : undefined)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Create Session</DialogTitle>
          <DialogDescription>Create a new session for {profileLabel}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Session name (optional)"
            autoFocus
          />

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Agent id preview:{' '}
              <span className="font-mono">
                {trimmedName.length === 0 ? '(auto-generated)' : (slugPreview || '(invalid)')}
              </span>
            </p>
            {showInvalidSlugWarning ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                This name has no usable characters for an agent id after slugifying.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ForkSessionDialog is now imported from ./ForkSessionDialog

// ── Rename dialog ──

function RenameSessionDialog({
  agentId,
  currentLabel,
  onConfirm,
  onClose,
}: {
  agentId: string
  currentLabel: string
  onConfirm: (agentId: string, label: string) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(currentLabel)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = label.trim()
    if (trimmed) {
      onConfirm(agentId, trimmed)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Rename Session</DialogTitle>
          <DialogDescription>Enter a new label for this session.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Session name"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!label.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Rename profile dialog ──

function RenameProfileDialog({
  profileId,
  currentName,
  onConfirm,
  onClose,
}: {
  profileId: string
  currentName: string
  onConfirm: (profileId: string, displayName: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(currentName)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed) {
      onConfirm(profileId, trimmed)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Rename Profile</DialogTitle>
          <DialogDescription>Enter a new display name for this profile.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Profile name"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Delete session confirmation dialog ──

function DeleteSessionDialog({
  agentId,
  sessionLabel,
  onConfirm,
  onClose,
}: {
  agentId: string
  sessionLabel: string
  onConfirm: (agentId: string) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Delete Session</DialogTitle>
          <DialogDescription>
            Delete &ldquo;{sessionLabel}&rdquo;? This will permanently remove the session history and memory. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(agentId)}
          >
            Delete session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Project Agent Settings Sheet ──

const PROJECT_AGENT_WHEN_TO_USE_MAX = 280

function ProjectAgentSettingsSheet({
  agentId,
  sessionLabel,
  currentProjectAgent,
  onSave,
  onDemote,
  onClose,
  onGetProjectAgentConfig,
  onListReferences,
  onGetReference,
  onSetReference,
  onDeleteReference,
  onRequestRecommendations,
}: {
  agentId: string
  sessionLabel: string
  currentProjectAgent: ProjectAgentInfo | null
  onSave: (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string }) => Promise<void>
  onDemote: (agentId: string) => Promise<void>
  onClose: () => void
  onGetProjectAgentConfig?: (agentId: string) => Promise<{ agentId: string; config: import('@forge/protocol').PersistedProjectAgentConfig; systemPrompt: string | null; references: string[] }>
  onListReferences?: (agentId: string) => Promise<{ agentId: string; references: string[] }>
  onGetReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string; content: string }>
  onSetReference?: (agentId: string, fileName: string, content: string) => Promise<{ agentId: string; fileName: string }>
  onDeleteReference?: (agentId: string, fileName: string) => Promise<{ agentId: string; fileName: string }>
  onRequestRecommendations?: (agentId: string) => Promise<{ whenToUse: string; systemPrompt: string }>
}) {
  const isPromoting = !currentProjectAgent

  const [handleInput, setHandleInput] = useState(slugifySessionName(sessionLabel))
  const normalizedHandle = slugifySessionName(handleInput)

  const [configLoading, setConfigLoading] = useState(!isPromoting)
  const [configError, setConfigError] = useState<string | null>(null)
  const fetchedSystemPromptRef = useRef<string>('')

  const [whenToUse, setWhenToUse] = useState(currentProjectAgent?.whenToUse ?? '')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [referenceDocs, setReferenceDocs] = useState<string[]>([])
  const [expandedReferenceFile, setExpandedReferenceFile] = useState<string | null>(null)
  const [referenceContents, setReferenceContents] = useState<Record<string, string>>({})
  const [loadedReferenceFiles, setLoadedReferenceFiles] = useState<Set<string>>(() => new Set())
  const [loadingReferenceFiles, setLoadingReferenceFiles] = useState<Set<string>>(() => new Set())
  const [savingReferenceFiles, setSavingReferenceFiles] = useState<Set<string>>(() => new Set())
  const [dirtyReferenceFiles, setDirtyReferenceFiles] = useState<Set<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const whenToUseDirtyRef = useRef(false)
  const systemPromptDirtyRef = useRef(false)

  const refreshReferenceDocs = useCallback(async () => {
    if (!onListReferences) return
    const result = await onListReferences(agentId)
    setReferenceDocs(result.references)
    setExpandedReferenceFile((previous) => (
      previous && !result.references.includes(previous) ? null : previous
    ))
  }, [agentId, onListReferences])

  useEffect(() => {
    if (isPromoting || !onGetProjectAgentConfig) return
    let cancelled = false
    setConfigLoading(true)
    setConfigError(null)
    void onGetProjectAgentConfig(agentId).then((result) => {
      if (cancelled) return
      const prompt = result.systemPrompt ?? ''
      fetchedSystemPromptRef.current = prompt
      if (!systemPromptDirtyRef.current) {
        setSystemPrompt(prompt)
      }
      setReferenceDocs(result.references)
      setConfigLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setConfigError(err instanceof Error ? err.message : 'Failed to load config.')
      setConfigLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, isPromoting])

  const trimmedWhenToUse = whenToUse.trim()
  const trimmedSystemPrompt = systemPrompt.trim()
  const canSave = isPromoting
    ? trimmedWhenToUse.length > 0 && trimmedWhenToUse.length <= PROJECT_AGENT_WHEN_TO_USE_MAX && normalizedHandle.length > 0
    : trimmedWhenToUse.length > 0 && trimmedWhenToUse.length <= PROJECT_AGENT_WHEN_TO_USE_MAX
  const hasChanges = isPromoting
    || trimmedWhenToUse !== (currentProjectAgent?.whenToUse ?? '')
    || trimmedSystemPrompt !== fetchedSystemPromptRef.current.trim()

  const requestRecommendations = useCallback(async (replaceExisting: boolean) => {
    if (!onRequestRecommendations) return
    setAnalyzing(true)
    setAnalysisError(null)
    try {
      const result = await onRequestRecommendations(agentId)
      if (replaceExisting) {
        setWhenToUse(result.whenToUse)
        setSystemPrompt(result.systemPrompt)
        whenToUseDirtyRef.current = false
        systemPromptDirtyRef.current = false
      } else {
        if (!whenToUseDirtyRef.current) {
          setWhenToUse(result.whenToUse)
        }
        if (!systemPromptDirtyRef.current) {
          setSystemPrompt(result.systemPrompt)
        }
      }
    } catch {
      setAnalysisError('AI analysis failed — you can fill in the fields manually.')
    } finally {
      setAnalyzing(false)
    }
  }, [agentId, onRequestRecommendations])

  useEffect(() => {
    if (isPromoting && onRequestRecommendations) {
      void requestRecommendations(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadReference = useCallback(async (fileName: string) => {
    if (!onGetReference) return
    setReferenceError(null)
    setLoadingReferenceFiles((prev) => new Set(prev).add(fileName))
    try {
      const result = await onGetReference(agentId, fileName)
      setReferenceContents((prev) => ({
        ...prev,
        [fileName]: prev[fileName] ?? result.content,
      }))
      setLoadedReferenceFiles((prev) => new Set(prev).add(fileName))
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to load ${fileName}.`)
    } finally {
      setLoadingReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
  }, [agentId, onGetReference])

  const handleWhenToUseChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    whenToUseDirtyRef.current = true
    setWhenToUse(e.target.value)
  }, [])

  const handleSystemPromptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    systemPromptDirtyRef.current = true
    setSystemPrompt(e.target.value)
  }, [])

  const handleToggleReference = useCallback((fileName: string) => {
    setExpandedReferenceFile((previous) => previous === fileName ? null : fileName)
    if (!loadedReferenceFiles.has(fileName) && !loadingReferenceFiles.has(fileName)) {
      void loadReference(fileName)
    }
  }, [loadReference, loadedReferenceFiles, loadingReferenceFiles])

  const handleReferenceContentChange = useCallback((fileName: string, nextContent: string) => {
    setReferenceContents((prev) => ({ ...prev, [fileName]: nextContent }))
    setDirtyReferenceFiles((prev) => new Set(prev).add(fileName))
  }, [])

  const handleSaveReference = useCallback(async (fileName: string) => {
    if (!onSetReference) return
    setReferenceError(null)
    setSavingReferenceFiles((prev) => new Set(prev).add(fileName))
    try {
      await onSetReference(agentId, fileName, referenceContents[fileName] ?? '')
      setDirtyReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      await refreshReferenceDocs()
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to save ${fileName}.`)
    } finally {
      setSavingReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
  }, [agentId, onSetReference, referenceContents, refreshReferenceDocs])

  const handleDeleteReference = useCallback(async (fileName: string) => {
    if (!onDeleteReference) return
    if (typeof window !== 'undefined' && !window.confirm(`Delete reference document \"${fileName}\"?`)) {
      return
    }

    setReferenceError(null)
    setSavingReferenceFiles((prev) => new Set(prev).add(fileName))
    try {
      await onDeleteReference(agentId, fileName)
      setReferenceDocs((prev) => prev.filter((entry) => entry !== fileName))
      setExpandedReferenceFile((prev) => prev === fileName ? null : prev)
      setReferenceContents((prev) => {
        const next = { ...prev }
        delete next[fileName]
        return next
      })
      setLoadedReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      setDirtyReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
      await refreshReferenceDocs()
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to delete ${fileName}.`)
    } finally {
      setSavingReferenceFiles((prev) => {
        const next = new Set(prev)
        next.delete(fileName)
        return next
      })
    }
  }, [agentId, onDeleteReference, refreshReferenceDocs])

  const handleAddReference = useCallback(async () => {
    if (!onSetReference) return
    const requestedFileName = typeof window !== 'undefined'
      ? window.prompt('Reference document filename', 'notes.md')
      : null
    const fileName = requestedFileName?.trim()
    if (!fileName) {
      return
    }

    setReferenceError(null)
    try {
      await onSetReference(agentId, fileName, '')
      await refreshReferenceDocs()
      setReferenceContents((prev) => ({ ...prev, [fileName]: prev[fileName] ?? '' }))
      setLoadedReferenceFiles((prev) => new Set(prev).add(fileName))
      setExpandedReferenceFile(fileName)
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : `Failed to create ${fileName}.`)
    }
  }, [agentId, onSetReference, refreshReferenceDocs])

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave(agentId, {
        whenToUse: trimmedWhenToUse,
        ...(trimmedSystemPrompt ? { systemPrompt: trimmedSystemPrompt } : {}),
        ...(isPromoting && normalizedHandle ? { handle: normalizedHandle } : {}),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project agent settings.')
    } finally {
      setSaving(false)
    }
  }

  const handleDemote = async () => {
    setSaving(true)
    setError(null)
    try {
      await onDemote(agentId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to demote project agent.')
    } finally {
      setSaving(false)
    }
  }

  const referenceEditingAvailable = !isPromoting && !!onGetReference && !!onSetReference && !!onDeleteReference

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent
        side="right"
        className={cn(
          'max-w-[90vw] overflow-y-auto',
          '[color-scheme:light] dark:[color-scheme:dark]',
          '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
          '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
          '[&::-webkit-scrollbar-thumb:hover]:bg-border/80',
        )}
        style={{ width: 600, maxWidth: '90vw', scrollbarWidth: 'thin', scrollbarColor: 'hsl(var(--border)) transparent' }}
      >
        <SheetHeader>
          <SheetTitle>{isPromoting ? 'Promote to Project Agent' : 'Project Agent Settings'}</SheetTitle>
          <SheetDescription>
            {isPromoting
              ? 'Make this session discoverable by other sessions in the same profile.'
              : 'Configure how other sessions discover and interact with this project agent.'}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Session</label>
            <p className="text-sm text-muted-foreground">{sessionLabel}</p>
          </div>

          {isPromoting ? (
            <div className="space-y-1.5">
              <label htmlFor="agentHandle" className="text-sm font-medium text-foreground">Handle</label>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">@</span>
                <Input
                  id="agentHandle"
                  value={handleInput}
                  onChange={(e) => setHandleInput(e.target.value)}
                  placeholder="agent-handle"
                  className="font-mono text-sm"
                />
              </div>
              {handleInput && normalizedHandle !== handleInput ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  Normalized: @{normalizedHandle || <span className="text-amber-500">(empty)</span>}
                </p>
              ) : null}
              {handleInput && !normalizedHandle ? (
                <p className="text-[11px] text-amber-500">
                  Handle must contain at least one letter, number, or dash.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground">Handle</label>
              <p className="font-mono text-sm text-muted-foreground">
                @{currentProjectAgent?.handle}
              </p>
            </div>
          )}

          {configLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>Loading configuration…</span>
            </div>
          ) : null}

          {configError ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              {configError}
            </p>
          ) : null}

          {analyzing ? (
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>Analyzing session to generate recommendations…</span>
            </div>
          ) : null}

          {analysisError ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              {analysisError}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="whenToUse" className="text-sm font-medium text-foreground">When to use</label>
            <Textarea
              id="whenToUse"
              value={whenToUse}
              onChange={handleWhenToUseChange}
              placeholder={analyzing ? 'Generating recommendation…' : 'Describe when other sessions should send messages to this agent…'}
              rows={3}
              maxLength={PROJECT_AGENT_WHEN_TO_USE_MAX}
              className="resize-none"
              autoFocus={!analyzing}
            />
            <p className="text-[11px] text-muted-foreground">
              {trimmedWhenToUse.length}/{PROJECT_AGENT_WHEN_TO_USE_MAX}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="systemPrompt" className="text-sm font-medium text-foreground">
              System Prompt
              <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="systemPrompt"
              value={systemPrompt}
              onChange={handleSystemPromptChange}
              placeholder={configLoading ? 'Loading…' : analyzing ? 'Generating recommendation…' : 'Custom system prompt for this project agent…'}
              rows={8}
              className="resize-y font-mono text-xs"
              disabled={configLoading}
            />
            <p className="text-[11px] text-muted-foreground">
              When set, this replaces the standard manager prompt for this session.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Reference Documents</label>
                <p className="text-[11px] text-muted-foreground">
                  Injected into this project agent's prompt inside <code>&lt;agent_reference_docs&gt;</code>.
                </p>
              </div>
              {!isPromoting ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleAddReference()}
                  disabled={!referenceEditingAvailable || configLoading || saving}
                  className="gap-1.5"
                >
                  <Plus className="size-3.5" />
                  Add Reference Document
                </Button>
              ) : null}
            </div>

            {isPromoting ? (
              <p className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Promote this session first, then add reference documents.
              </p>
            ) : null}

            {!isPromoting && !referenceEditingAvailable ? (
              <p className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Reference document editing is unavailable right now.
              </p>
            ) : null}

            {!isPromoting && referenceDocs.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground">
                No reference documents yet.
              </p>
            ) : null}

            {!isPromoting && referenceDocs.length > 0 ? (
              <div className="space-y-2">
                {referenceDocs.map((fileName) => {
                  const isExpanded = expandedReferenceFile === fileName
                  const isLoading = loadingReferenceFiles.has(fileName)
                  const isSavingReference = savingReferenceFiles.has(fileName)
                  const isDirty = dirtyReferenceFiles.has(fileName)
                  const content = referenceContents[fileName] ?? ''

                  return (
                    <div key={fileName} className="overflow-hidden rounded-md border border-border/60">
                      <div className="flex items-center gap-2 px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleToggleReference(fileName)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {isExpanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                          <span className="min-w-0 truncate font-mono text-sm">{fileName}</span>
                          {isDirty ? (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                              Unsaved
                            </span>
                          ) : null}
                        </button>
                        {isSavingReference ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteReference(fileName)}
                          disabled={isSavingReference || saving}
                        >
                          <Trash2 className="size-4" />
                          <span className="sr-only">Delete {fileName}</span>
                        </Button>
                      </div>
                      {isExpanded ? (
                        <div className="space-y-2 border-t border-border/60 px-3 py-3">
                          {isLoading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="size-4 animate-spin" />
                              <span>Loading document…</span>
                            </div>
                          ) : (
                            <>
                              <Textarea
                                value={content}
                                onChange={(event) => handleReferenceContentChange(fileName, event.target.value)}
                                rows={10}
                                className="resize-y font-mono text-xs"
                              />
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-[11px] text-muted-foreground">
                                  Markdown content injected into this project agent's runtime prompt.
                                </p>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void handleSaveReference(fileName)}
                                  disabled={!isDirty || isSavingReference || saving}
                                >
                                  Save
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}

            {referenceError ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                {referenceError}
              </p>
            ) : null}
          </div>

          {!isPromoting && onRequestRecommendations ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void requestRecommendations(true)}
              disabled={analyzing || configLoading}
              className="gap-1.5"
            >
              {analyzing
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Sparkles className="size-3.5" />
              }
              Regenerate recommendations
            </Button>
          ) : null}

          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={!canSave || !hasChanges || saving || configLoading}>
              {saving ? 'Saving…' : isPromoting ? 'Promote' : 'Save'}
            </Button>
            {!isPromoting ? (
              <Button variant="outline" onClick={handleDemote} disabled={saving} className="text-destructive hover:text-destructive">
                Demote
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ── Change model dialog ──

const STATIC_CHANGE_MODEL_FAMILIES = getChangeManagerFamilies()

const REASONING_LEVEL_LABELS: Record<ManagerReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

function ChangeModelDialog({
  wsUrl,
  profileId,
  profileLabel,
  currentPreset,
  currentReasoningLevel,
  onConfirm,
  onClose,
}: {
  wsUrl?: string
  profileId: string
  profileLabel: string
  currentPreset: ManagerModelPreset | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  onConfirm: (profileId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => void
  onClose: () => void
}) {
  const modelPresets = useModelPresets(wsUrl, 1)
  const changeModelFamilies = useMemo(() => {
    const presetInfoById = new Map(modelPresets.map((preset) => [preset.presetId, preset]))
    const hasServerFilteredFamilies = modelPresets.length > 0

    return STATIC_CHANGE_MODEL_FAMILIES.flatMap((family) => {
      const preset = presetInfoById.get(family.familyId)
      if (!preset && hasServerFilteredFamilies) {
        return []
      }

      return [{
        familyId: family.familyId,
        displayName: preset?.displayName ?? family.displayName,
      }]
    })
  }, [modelPresets])

  const [model, setModel] = useState<ManagerModelPreset>(currentPreset ?? 'pi-codex')
  const [reasoning, setReasoning] = useState<ManagerReasoningLevel>(currentReasoningLevel ?? 'xhigh')

  useEffect(() => {
    if (changeModelFamilies.some((family) => family.familyId === model)) {
      return
    }

    const fallbackFamilyId = changeModelFamilies[0]?.familyId
    if (fallbackFamilyId) {
      setModel(fallbackFamilyId as ManagerModelPreset)
    }
  }, [changeModelFamilies, model])

  const hasChanges = model !== currentPreset || reasoning !== (currentReasoningLevel ?? 'xhigh')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onConfirm(profileId, model, reasoning)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Change Model</DialogTitle>
          <DialogDescription>
            Update the model and reasoning level for {profileLabel}. Changes take effect on the next session resume or new message.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Model</label>
            <Select
              value={model}
              onValueChange={(value) => setModel(value as ManagerModelPreset)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select model preset" />
              </SelectTrigger>
              <SelectContent>
                {changeModelFamilies.map((family) => (
                  <SelectItem key={family.familyId} value={family.familyId}>
                    {family.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Reasoning Level</label>
            <Select
              value={reasoning}
              onValueChange={(value) => setReasoning(value as ManagerReasoningLevel)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select reasoning level" />
              </SelectTrigger>
              <SelectContent>
                {MANAGER_REASONING_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {REASONING_LEVEL_LABELS[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Higher reasoning uses more tokens but improves complex task performance.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!hasChanges}>
              Update
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Cortex section ──

function CortexSection({
  cortexRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  collapsedSessionIds,
  visibleSessionLimit,
  expandedWorkerListSessionIds,
  onToggleCollapsed,
  onToggleSessionCollapsed,
  onShowMoreSessions,
  onShowLessSessions,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onOpenCortexReview,
  outstandingReviewCount,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRequestRenameSession,
  onRequestRenameProfile,
  onForkSession,
  onMarkUnread,
  onMarkAllRead,
  onChangeModel,
  highlightQuery,
}: {
  cortexRow: ProfileTreeRow
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  collapsedSessionIds: Set<string>
  visibleSessionLimit: number
  expandedWorkerListSessionIds: Set<string>
  onToggleCollapsed: () => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onShowMoreSessions: () => void
  onShowLessSessions: () => void
  onToggleWorkerListExpanded: (sessionId: string) => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onOpenSettings: () => void
  onOpenCortexReview?: (agentId: string) => void
  outstandingReviewCount?: number | null
  onCreateSession?: (profileId: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onRequestRenameSession?: (agentId: string) => void
  onRequestRenameProfile?: (profileId: string) => void
  onForkSession?: (sourceAgentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onChangeModel?: (profileId: string) => void
  highlightQuery?: string
}) {
  const { profile, sessions } = cortexRow
  const reviewRunSessions = sessions.filter((session) => session.sessionAgent.sessionPurpose === 'cortex_review')
  const primarySessions = sessions.filter((session) => session.sessionAgent.sessionPurpose !== 'cortex_review')
  const selectedReviewRunSession = reviewRunSessions.find(
    (session) =>
      session.sessionAgent.agentId === selectedAgentId ||
      session.workers.some((worker) => worker.agentId === selectedAgentId),
  )
  const isSearchActive = Boolean(highlightQuery?.trim())
  const visibleSessions = isSearchActive
    ? sessions
    : selectedReviewRunSession
      ? [selectedReviewRunSession, ...primarySessions]
      : primarySessions

  const defaultSession = visibleSessions.find((s) => s.isDefault) ?? sessions.find((s) => s.isDefault)
  const targetId = visibleSessions[0]?.sessionAgent.agentId ?? sessions[0]?.sessionAgent.agentId
  const isHeaderSelected = !isSettingsActive && selectedAgentId === targetId
  const hasAnySessions = visibleSessions.length > 0

  // Unread: aggregate when collapsed, root-only when expanded
  const totalUnread = visibleSessions.reduce(
    (sum, s) => sum + (unreadCounts[s.sessionAgent.agentId] ?? 0), 0,
  )
  const rootUnread = targetId ? (unreadCounts[targetId] ?? 0) : 0
  const displayUnread = isCollapsed ? totalUnread : rootUnread
  const showUnread = displayUnread > 0

  // Activity
  const activeReviewRunCount = reviewRunSessions.filter((session) => {
    const reviewStatus = getAgentLiveStatus(session.sessionAgent, statuses).status
    return reviewStatus === 'streaming' || session.workers.some((worker) => getAgentLiveStatus(worker, statuses).status === 'streaming')
  }).length
  const activeSessionCount = visibleSessions.filter((s) => isSessionRunning(s.sessionAgent)).length

  // Root session status
  const cortexAgent = defaultSession?.sessionAgent ?? visibleSessions[0]?.sessionAgent ?? sessions[0]?.sessionAgent
  const cortexStatus = cortexAgent ? getAgentLiveStatus(cortexAgent, statuses).status : null
  const cortexRunning = cortexStatus === 'idle' || cortexStatus === 'streaming'

  return (
    <div className="border-b border-sidebar-border px-2 pb-2">
      {/* Cortex header */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex items-center rounded-lg border border-white/[0.04] bg-white/[0.03]">
            {hasAnySessions ? (
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} Cortex`}
                aria-expanded={!isCollapsed}
                className={cn(
                  'group absolute left-1 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 transition',
                  'hover:text-sidebar-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                )}
              >
                <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                  <Brain
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0',
                      isHeaderSelected ? 'text-blue-500' : 'text-blue-400',
                    )}
                  />
                  {isCollapsed ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                    />
                  ) : (
                    <ChevronDown
                      aria-hidden="true"
                      className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                    />
                  )}
                </span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => targetId && onSelect(targetId)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pr-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                hasAnySessions ? 'pl-7' : 'px-2',
                isHeaderSelected
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
              )}
              title="Cortex — Knowledge Intelligence"
            >
              {!hasAnySessions ? (
                <Brain className={cn('size-4 shrink-0', isHeaderSelected ? 'text-blue-500' : 'text-blue-400')} aria-hidden="true" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                {profile.displayName}
              </span>
              {isCollapsed && visibleSessions.length > 1 ? (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {activeSessionCount}/{visibleSessions.length}
                </span>
              ) : null}
              {typeof outstandingReviewCount === 'number' && outstandingReviewCount > 0 && !isSearchActive ? (
                <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  Review {outstandingReviewCount}
                </span>
              ) : null}
              {activeReviewRunCount > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[9px] text-blue-500">
                  <CircleDashed className="size-2.5 animate-spin" aria-hidden="true" />
                  Running
                </span>
              ) : null}
              {showUnread ? (
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
                  {displayUnread > 99 ? '99+' : displayUnread}
                </span>
              ) : null}
            </button>

            {/* New session button */}
            {onCreateSession ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onCreateSession(profile.profileId)
                      }}
                      className={cn(
                        'mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition',
                        'hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                      aria-label="New Cortex session"
                    >
                      <Plus className="size-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
                    New session
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {onCreateSession ? (
            <ContextMenuItem onClick={() => onCreateSession(profile.profileId)}>
              <Plus className="mr-2 size-3.5" />
              New Session
            </ContextMenuItem>
          ) : null}
          {onRequestRenameProfile ? (
            <ContextMenuItem onClick={() => onRequestRenameProfile(profile.profileId)}>
              <Edit3 className="mr-2 size-3.5" />
              Rename
            </ContextMenuItem>
          ) : null}
          {onChangeModel ? (
            <ContextMenuItem onClick={() => onChangeModel(profile.profileId)}>
              <RefreshCw className="mr-2 size-3.5" />
              Change Model
            </ContextMenuItem>
          ) : null}
          {cortexRunning && onStopSession && targetId ? (
            <ContextMenuItem onClick={() => onStopSession(targetId)}>
              <Pause className="mr-2 size-3.5" />
              Stop Root Session
            </ContextMenuItem>
          ) : null}
          {onMarkAllRead && visibleSessions.some((s) => (unreadCounts[s.sessionAgent.agentId] ?? 0) > 0) ? (
            <ContextMenuItem onClick={() => onMarkAllRead(profile.profileId)}>
              <CheckCheck className="mr-2 size-3.5" />
              Mark All as Read
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Sessions list (same pattern as ProfileGroup) */}
      {!isCollapsed && hasAnySessions ? (
        <div className="relative mt-1">
          {(() => {
            const hasMore = visibleSessions.length > visibleSessionLimit
            const isExpanded = visibleSessionLimit > MAX_VISIBLE_SESSIONS
            let renderedSessions: SessionRow[]
            let hiddenCount = 0

            if (!hasMore) {
              renderedSessions = visibleSessions
            } else {
              const topSessions = visibleSessions.slice(0, visibleSessionLimit)
              const selectedSessionInTop = !selectedAgentId || isSettingsActive || topSessions.some(
                (s) =>
                  s.sessionAgent.agentId === selectedAgentId ||
                  s.workers.some((w) => w.agentId === selectedAgentId),
              )

              if (selectedSessionInTop) {
                renderedSessions = topSessions
              } else {
                const selectedSession = visibleSessions.find(
                  (s) =>
                    s.sessionAgent.agentId === selectedAgentId ||
                    s.workers.some((w) => w.agentId === selectedAgentId),
                )
                if (selectedSession) {
                  renderedSessions = [...topSessions.slice(0, visibleSessionLimit - 1), selectedSession]
                } else {
                  renderedSessions = topSessions
                }
              }
              hiddenCount = visibleSessions.length - renderedSessions.length
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {renderedSessions.map((session) => {
                    const sessionCollapsed = !collapsedSessionIds.has(session.sessionAgent.agentId)

                    return (
                      <SessionRowItem
                        key={session.sessionAgent.agentId}
                        session={session}
                        statuses={statuses}
                        unreadCount={unreadCounts[session.sessionAgent.agentId] ?? 0}
                        selectedAgentId={selectedAgentId}
                        isSettingsActive={isSettingsActive}
                        isCollapsed={sessionCollapsed}
                        isWorkerListExpanded={expandedWorkerListSessionIds.has(session.sessionAgent.agentId)}
                        onToggleCollapse={() => onToggleSessionCollapsed(session.sessionAgent.agentId)}
                        onToggleWorkerListExpanded={() => onToggleWorkerListExpanded(session.sessionAgent.agentId)}
                        onSelect={onSelect}
                        onDeleteAgent={onDeleteAgent}
                        onStop={onStopSession ? () => onStopSession(session.sessionAgent.agentId) : undefined}
                        onResume={onResumeSession ? () => onResumeSession(session.sessionAgent.agentId) : undefined}
                        onDelete={!session.isDefault && onDeleteSession ? () => onDeleteSession(session.sessionAgent.agentId) : undefined}
                        onRename={onRequestRenameSession ? () => onRequestRenameSession(session.sessionAgent.agentId) : undefined}
                        onFork={onForkSession ? () => onForkSession(session.sessionAgent.agentId) : undefined}
                        onMarkUnread={onMarkUnread ? () => onMarkUnread(session.sessionAgent.agentId) : undefined}
                        onStopWorker={onStopSession}
                        onResumeWorker={onResumeSession}
                        highlightQuery={highlightQuery}
                      />
                    )
                  })}
                </ul>
                {hasMore || isExpanded ? (
                  <div className="relative z-10 mt-0.5 flex items-center gap-2 pl-5 pr-1.5">
                    {hasMore ? (
                      <button
                        type="button"
                        onClick={onShowMoreSessions}
                        className={cn(
                          'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-muted-foreground/70 transition-colors',
                          'hover:text-muted-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        )}
                      >
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenCount} more</span>
                      </button>
                    ) : null}
                    {isExpanded ? (
                      <button
                        type="button"
                        onClick={onShowLessSessions}
                        className={cn(
                          'flex items-center gap-1 rounded-md py-1 text-left text-[11px] text-muted-foreground/70 transition-colors',
                          'hover:text-muted-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                        )}
                      >
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {reviewRunSessions.length > 0 && !selectedReviewRunSession ? (
                  onOpenCortexReview && targetId ? (
                    <button
                      type="button"
                      className={cn(
                        'px-5 pt-1 text-left text-[10px] text-muted-foreground/70 transition-colors',
                        'hover:text-muted-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      )}
                      onClick={() => onOpenCortexReview(targetId)}
                    >
                      {reviewRunSessions.length} review run{reviewRunSessions.length === 1 ? '' : 's'} hidden here — open them from Cortex Review.
                    </button>
                  ) : (
                    <p className="px-5 pt-1 text-[10px] text-muted-foreground/70">
                      {reviewRunSessions.length} review run{reviewRunSessions.length === 1 ? '' : 's'} hidden here — open them from Cortex Review.
                    </p>
                  )
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}

// ── Sortable profile wrapper ──

function SortableProfileGroup({
  treeRow,
  children,
}: {
  treeRow: ProfileTreeRow
  children: (dragHandleRef: (element: HTMLElement | null) => void, dragHandleListeners: Record<string, any> | undefined) => React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: treeRow.profile.profileId })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <li ref={setNodeRef} style={style} {...attributes}>
      {children(setActivatorNodeRef, listeners)}
    </li>
  )
}

// ── Main sidebar ──

export function AgentSidebar({
  connected,
  wsUrl,
  agents,
  profiles,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isPlaywrightActive = false,
  isStatsActive = false,
  showPlaywrightNav = false,
  isMobileOpen = false,
  onMobileClose,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
  onOpenSettings,
  onOpenCortexReview,
  onOpenPlaywright,
  onOpenStats,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRenameSession,
  onPinSession,
  onRenameProfile,
  onForkSession,
  onMarkUnread,
  onMarkAllRead,
  onUpdateManagerModel,
  onUpdateManagerCwd,
  onBrowseDirectory,
  onValidateDirectory,
  onRequestSessionWorkers,
  onReorderProfiles,
  onSetSessionProjectAgent,
  onGetProjectAgentConfig,
  onListProjectAgentReferences,
  onGetProjectAgentReference,
  onSetProjectAgentReference,
  onDeleteProjectAgentReference,
  onRequestProjectAgentRecommendations,
  onCreateAgentCreator,
}: AgentSidebarProps) {
  const treeRows = buildProfileTreeRows(agents, profiles)
  const hasCortexProfile = profiles.some((profile) => profile.profileId === 'cortex')

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [cortexOutstandingReviewCount, setCortexOutstandingReviewCount] = useState<number | null>(null)
  const [showModelIcons, setShowModelIcons] = useState(() => readSidebarModelIconsPref())
  const [showProviderUsage, setShowProviderUsage] = useState(() => readSidebarProviderUsagePref())
  const [usagePanelOpen, setUsagePanelOpen] = useState(false)
  const { data: providerUsage, loading: providerUsageLoading, refetch: refetchProviderUsage } = useProviderUsage(showProviderUsage)

  // Re-read pref on custom event (same-tab) and storage event (cross-tab)
  useEffect(() => {
    const update = () => {
      setShowModelIcons(readSidebarModelIconsPref())
      setShowProviderUsage(readSidebarProviderUsagePref())
    }
    window.addEventListener('forge-sidebar-pref-change', update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener('forge-sidebar-pref-change', update)
      window.removeEventListener('storage', update)
    }
  }, [])

  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Cmd+K / Ctrl+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Parse the search query for the highlight term (strip prefix)
  const parsedSearch = useMemo(() => parseSearchQuery(searchQuery), [searchQuery])
  const isSearchActive = parsedSearch.term.length > 0

  useEffect(() => {
    if (!connected || !hasCortexProfile) {
      setCortexOutstandingReviewCount(null)
      return
    }

    const controller = new AbortController()
    const endpoint = resolveApiEndpoint(wsUrl, '/api/cortex/scan')

    void fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Cortex scan failed (${response.status})`)
        }
        return response.json() as Promise<CortexScanBadgeResponse>
      })
      .then((payload) => {
        if (controller.signal.aborted) return
        setCortexOutstandingReviewCount(
          typeof payload.scan?.summary?.needsReview === 'number' ? payload.scan.summary.needsReview : 0,
        )
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setCortexOutstandingReviewCount(null)
      })

    return () => controller.abort()
  }, [connected, hasCortexProfile, wsUrl])

  // Filter tree rows when search is active
  const { filtered: filteredTreeRows, matchCount } = useMemo(
    () => filterTreeRows(treeRows, searchQuery),
    [treeRows, searchQuery],
  )

  const [collapsedProfileIds, setCollapsedProfileIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('forge-sidebar-collapsed-profiles')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed)) return new Set(parsed)
      }
    } catch {
      // Ignore corrupt/missing localStorage
    }
    return new Set()
  })
  // Track explicitly expanded sessions — everything defaults to collapsed
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  // Track how many sessions are visible per profile (default: MAX_VISIBLE_SESSIONS, increments by SESSION_PAGE_SIZE)
  const [sessionListLimits, setSessionListLimits] = useState<Record<string, number>>({})
  // Track which sessions have their full worker list expanded (default: collapsed to MAX_VISIBLE_WORKERS)
  const [expandedWorkerListSessionIds, setExpandedWorkerListSessionIds] = useState<Set<string>>(() => new Set())
  const [createTarget, setCreateTarget] = useState<{ profileId: string; profileLabel: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [renameProfileTarget, setRenameProfileTarget] = useState<{ profileId: string; displayName: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [forkTarget, setForkTarget] = useState<{ sourceAgentId: string } | null>(null)
  const [changeModelTarget, setChangeModelTarget] = useState<{
    profileId: string
    profileLabel: string
    currentPreset: ManagerModelPreset | undefined
    currentReasoningLevel: ManagerReasoningLevel | undefined
  } | null>(null)
  const [changeCwdTarget, setChangeCwdTarget] = useState<{
    profileId: string
    profileLabel: string
    currentCwd: string
  } | null>(null)
  const [projectAgentTarget, setProjectAgentTarget] = useState<{
    agentId: string
    sessionLabel: string
    currentProjectAgent: ProjectAgentInfo | null
  } | null>(null)

  const toggleProfileCollapsed = useCallback((profileId: string) => {
    setCollapsedProfileIds((prev) => {
      const next = new Set(prev)
      if (next.has(profileId)) {
        next.delete(profileId)
      } else {
        next.add(profileId)
      }
      return next
    })
  }, [])

  const toggleSessionCollapsed = useCallback((sessionId: string) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
        onRequestSessionWorkers?.(sessionId)
      }
      return next
    })
  }, [onRequestSessionWorkers])

  const showMoreSessions = useCallback((profileId: string) => {
    setSessionListLimits((prev) => ({
      ...prev,
      [profileId]: (prev[profileId] ?? MAX_VISIBLE_SESSIONS) + SESSION_PAGE_SIZE,
    }))
  }, [])

  const showLessSessions = useCallback((profileId: string) => {
    setSessionListLimits((prev) => {
      const next = { ...prev }
      delete next[profileId]
      return next
    })
  }, [])

  const toggleWorkerListExpanded = useCallback((sessionId: string) => {
    setExpandedWorkerListSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
        onRequestSessionWorkers?.(sessionId)
      }
      return next
    })
  }, [onRequestSessionWorkers])

  // Persist profile collapse state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(
        'forge-sidebar-collapsed-profiles',
        JSON.stringify([...collapsedProfileIds]),
      )
    } catch {
      // Ignore localStorage write failures (quota, etc.)
    }
  }, [collapsedProfileIds])

  const handleSelectAgent = useCallback((agentId: string) => {
    onSelectAgent(agentId)
    onMobileClose?.()
  }, [onSelectAgent, onMobileClose])

  const handleOpenSettings = useCallback(() => {
    onOpenSettings()
    onMobileClose?.()
  }, [onOpenSettings, onMobileClose])

  const handleOpenCortexReview = useCallback((agentId: string) => {
    onOpenCortexReview?.(agentId)
    onMobileClose?.()
  }, [onOpenCortexReview, onMobileClose])

  const handleOpenPlaywright = useCallback(() => {
    onOpenPlaywright?.()
    onMobileClose?.()
  }, [onOpenPlaywright, onMobileClose])

  const handleOpenStats = useCallback(() => {
    onOpenStats?.()
    onMobileClose?.()
  }, [onOpenStats, onMobileClose])

  const handleRequestCreateSession = useCallback((profileId: string) => {
    const profile = profiles.find((entry) => entry.profileId === profileId)
    setCreateTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
    })
  }, [profiles])

  const handleConfirmCreateSession = useCallback((profileId: string, name?: string) => {
    onCreateSession?.(profileId, name)
    setCreateTarget(null)
  }, [onCreateSession])

  const handleRequestRename = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setRenameTarget({
      agentId,
      label: agent.sessionLabel || agent.displayName || agent.agentId,
    })
  }, [agents])

  const handleConfirmRename = useCallback((agentId: string, label: string) => {
    onRenameSession?.(agentId, label)
    setRenameTarget(null)
  }, [onRenameSession])

  const handleRequestRenameProfile = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    if (!profile) return
    setRenameProfileTarget({
      profileId,
      displayName: profile.displayName,
    })
  }, [profiles])

  const handleConfirmRenameProfile = useCallback((profileId: string, displayName: string) => {
    onRenameProfile?.(profileId, displayName)
    setRenameProfileTarget(null)
  }, [onRenameProfile])

  const handleRequestDelete = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setDeleteTarget({
      agentId,
      label: agent.sessionLabel || agent.displayName || agent.agentId,
    })
  }, [agents])

  const handleConfirmDelete = useCallback((agentId: string) => {
    onDeleteSession?.(agentId)
    setDeleteTarget(null)
  }, [onDeleteSession])

  const handleRequestChangeModel = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    const defaultSession = agents.find(
      (a) => a.role === 'manager' && (a.profileId === profileId || a.agentId === profileId),
    )
    const currentPreset = defaultSession ? inferModelPreset(defaultSession) : undefined
    const currentReasoningLevel = defaultSession?.model.thinkingLevel as ManagerReasoningLevel | undefined
    setChangeModelTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
      currentPreset,
      currentReasoningLevel,
    })
  }, [agents, profiles])

  const handleConfirmChangeModel = useCallback((profileId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => {
    onUpdateManagerModel?.(profileId, model, reasoningLevel)
    setChangeModelTarget(null)
  }, [onUpdateManagerModel])

  const handleRequestChangeCwd = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.profileId === profileId)
    const defaultSession = agents.find(
      (a) => a.role === 'manager' && (a.profileId === profileId || a.agentId === profileId),
    )
    setChangeCwdTarget({
      profileId,
      profileLabel: profile?.displayName || profileId,
      currentCwd: defaultSession?.cwd || '',
    })
  }, [agents, profiles])

  const handleConfirmChangeCwd = useCallback(async (profileId: string, cwd: string) => {
    if (!onUpdateManagerCwd) return
    await onUpdateManagerCwd(profileId, cwd)
    setChangeCwdTarget(null)
  }, [onUpdateManagerCwd])

  const handlePromoteToProjectAgent = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setProjectAgentTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: null,
    })
  }, [agents])

  const handleOpenProjectAgentSettings = useCallback((agentId: string) => {
    const agent = agents.find((a) => a.agentId === agentId)
    if (!agent) return
    setProjectAgentTarget({
      agentId,
      sessionLabel: agent.sessionLabel || agent.displayName || agent.agentId,
      currentProjectAgent: agent.projectAgent ?? null,
    })
  }, [agents])

  const handleDemoteProjectAgent = useCallback(async (agentId: string) => {
    await onSetSessionProjectAgent?.(agentId, null)
  }, [onSetSessionProjectAgent])

  const handleSaveProjectAgent = useCallback(async (agentId: string, projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string }) => {
    await onSetSessionProjectAgent?.(agentId, projectAgent)
  }, [onSetSessionProjectAgent])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over || active.id === over.id || !onReorderProfiles) return

    const sourceRows = isSearchActive ? filteredTreeRows : treeRows
    const regularRows = sourceRows.filter((row) => !isCortexProfile(row))
    const currentIds = regularRows.map((r) => r.profile.profileId)
    const oldIndex = currentIds.indexOf(active.id as string)
    const newIndex = currentIds.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = arrayMove(currentIds, oldIndex, newIndex)
    onReorderProfiles(newOrder)
  }, [onReorderProfiles, treeRows, filteredTreeRows, isSearchActive])

  const sidebarContent = (
    <aside
      data-tour="sidebar"
      className={cn(
        'flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        'max-md:w-full md:w-[20rem] md:min-w-[20rem] md:shrink-0',
      )}
    >
      <div className="mb-2 flex h-[62px] shrink-0 items-center gap-2 border-b border-sidebar-border px-2">
        <button
          type="button"
          onClick={onAddManager}
          className="flex min-h-[44px] flex-1 items-center gap-2 rounded-md p-2 text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
          title="Create project"
          aria-label="Add project"
        >
          <SquarePen aria-hidden="true" className="h-4 w-4" />
          <span>New Project</span>
        </button>
        <div className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground">
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-amber-500',
            )}
            title={connected ? 'Connected' : 'Reconnecting'}
          />
          <span className="hidden xl:inline">{connected ? 'Live' : 'Retrying'}</span>
        </div>
        {onMobileClose ? (
          <button
            type="button"
            onClick={onMobileClose}
            className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground md:hidden"
            aria-label="Close sidebar"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </div>

      {/* Search bar */}
      <div className="px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden="true" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sessions… ⌘K"
            className="h-7 pl-7 pr-7 text-xs placeholder:text-muted-foreground/50"
          />
          {searchQuery.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                searchInputRef.current?.focus()
              }}
              className="absolute right-1.5 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--sidebar-border) transparent',
        }}
      >
        {/* Pinned Cortex entry */}
        {(() => {
          const sourceRows = isSearchActive ? filteredTreeRows : treeRows
          const cortexRow = sourceRows.find((row) => isCortexProfile(row))
          if (!cortexRow) return null

          return (
            <CortexSection
              cortexRow={cortexRow}
              statuses={statuses}
              unreadCounts={unreadCounts}
              selectedAgentId={selectedAgentId}
              isSettingsActive={isSettingsActive}
              isCollapsed={isSearchActive ? false : collapsedProfileIds.has('cortex')}
              collapsedSessionIds={expandedSessionIds}
              visibleSessionLimit={isSearchActive ? Infinity : (sessionListLimits['cortex'] ?? MAX_VISIBLE_SESSIONS)}
              expandedWorkerListSessionIds={expandedWorkerListSessionIds}
              onToggleCollapsed={() => toggleProfileCollapsed('cortex')}
              onToggleSessionCollapsed={toggleSessionCollapsed}
              onShowMoreSessions={() => showMoreSessions('cortex')}
              onShowLessSessions={() => showLessSessions('cortex')}
              onToggleWorkerListExpanded={toggleWorkerListExpanded}
              onSelect={handleSelectAgent}
              onDeleteAgent={onDeleteAgent}
              onOpenSettings={handleOpenSettings}
              onOpenCortexReview={handleOpenCortexReview}
              outstandingReviewCount={cortexOutstandingReviewCount}
              onCreateSession={onCreateSession ? handleRequestCreateSession : undefined}
              onStopSession={onStopSession}
              onResumeSession={onResumeSession}
              onDeleteSession={handleRequestDelete}
              onRequestRenameSession={handleRequestRename}
              onRequestRenameProfile={onRenameProfile ? handleRequestRenameProfile : undefined}
              onForkSession={onForkSession ? (sourceAgentId: string) => setForkTarget({ sourceAgentId }) : undefined}
              onMarkUnread={onMarkUnread}
              onMarkAllRead={onMarkAllRead}
              onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
              highlightQuery={isSearchActive ? parsedSearch.term : undefined}
            />
          )
        })()}

        {isSearchActive ? (
          <div className="px-1 pb-1">
            <h2 className="text-xs font-semibold text-muted-foreground">
              {matchCount} match{matchCount !== 1 ? 'es' : ''}
            </h2>
          </div>
        ) : null}

        {(() => {
          const sourceRows = isSearchActive ? filteredTreeRows : treeRows
          const regularRows = sourceRows.filter((row) => !isCortexProfile(row))

          if (isSearchActive && regularRows.length === 0 && !sourceRows.some((r) => isCortexProfile(r))) {
            return (
              <p className="rounded-md px-3 py-4 text-center text-xs text-muted-foreground">
                No matches found.
              </p>
            )
          }

          if (regularRows.length === 0 && !isSearchActive) {
            return (
              <p className="rounded-md bg-sidebar-accent/50 px-3 py-4 text-center text-xs text-muted-foreground">
                No active agents.
              </p>
            )
          }

          const profileGroupContent = (treeRow: ProfileTreeRow, dragHandleRef?: (element: HTMLElement | null) => void, dragHandleListeners?: Record<string, any>) => (
            <ProfileGroup
              treeRow={treeRow}
              statuses={statuses}
              unreadCounts={unreadCounts}
              selectedAgentId={selectedAgentId}
              isSettingsActive={isSettingsActive}
              isCollapsed={isSearchActive ? false : collapsedProfileIds.has(treeRow.profile.profileId)}
              collapsedSessionIds={expandedSessionIds}
              visibleSessionLimit={isSearchActive ? Infinity : (sessionListLimits[treeRow.profile.profileId] ?? MAX_VISIBLE_SESSIONS)}
              expandedWorkerListSessionIds={expandedWorkerListSessionIds}
              onToggleProfileCollapsed={() => toggleProfileCollapsed(treeRow.profile.profileId)}
              onToggleSessionCollapsed={toggleSessionCollapsed}
              onShowMoreSessions={() => showMoreSessions(treeRow.profile.profileId)}
              onShowLessSessions={() => showLessSessions(treeRow.profile.profileId)}
              onToggleWorkerListExpanded={toggleWorkerListExpanded}
              onSelect={handleSelectAgent}
              onDeleteAgent={onDeleteAgent}
              onDeleteManager={onDeleteManager}
              onOpenSettings={handleOpenSettings}
              onCreateSession={onCreateSession ? handleRequestCreateSession : undefined}
              onStopSession={onStopSession}
              onResumeSession={onResumeSession}
              onDeleteSession={handleRequestDelete}
              onRequestRenameSession={handleRequestRename}
              onRequestRenameProfile={onRenameProfile ? handleRequestRenameProfile : undefined}
              onForkSession={onForkSession ? (sourceAgentId: string) => setForkTarget({ sourceAgentId }) : undefined}
              onMarkUnread={onMarkUnread}
              onMarkAllRead={onMarkAllRead}
              onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
              onChangeCwd={onUpdateManagerCwd ? handleRequestChangeCwd : undefined}
              showModelIcons={showModelIcons}
              highlightQuery={isSearchActive ? parsedSearch.term : undefined}
              dragHandleRef={dragHandleRef}
              dragHandleListeners={dragHandleListeners}
              onPromoteToProjectAgent={onSetSessionProjectAgent ? handlePromoteToProjectAgent : undefined}
              onOpenProjectAgentSettings={onSetSessionProjectAgent ? handleOpenProjectAgentSettings : undefined}
              onPinSession={onPinSession}
              onDemoteProjectAgent={onSetSessionProjectAgent ? handleDemoteProjectAgent : undefined}
              onCreateAgentCreator={onCreateAgentCreator}
            />
          )

          const dndEnabled = !isSearchActive && onReorderProfiles && regularRows.length > 1
          const sortableIds = regularRows.map((r) => r.profile.profileId)
          const activeDragRow = activeDragId ? regularRows.find((r) => r.profile.profileId === activeDragId) : null

          if (dndEnabled) {
            return (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(event) => setActiveDragId(event.active.id as string)}
                onDragCancel={() => setActiveDragId(null)}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <ul className="mt-2 space-y-1">
                    {regularRows.map((treeRow) => (
                      <SortableProfileGroup key={treeRow.profile.profileId} treeRow={treeRow}>
                        {(dragHandleRef, dragHandleListeners) => profileGroupContent(treeRow, dragHandleRef, dragHandleListeners)}
                      </SortableProfileGroup>
                    ))}
                  </ul>
                </SortableContext>
                <DragOverlay>
                  {activeDragRow ? (
                    <div className="rounded-md border border-sidebar-border bg-sidebar shadow-lg">
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        <span className="text-sm font-semibold">{activeDragRow.profile.displayName}</span>
                      </div>
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )
          }

          return (
            <ul className="mt-2 space-y-1">
              {regularRows.map((treeRow) => (
                <li key={treeRow.profile.profileId}>
                  {profileGroupContent(treeRow)}
                </li>
              ))}
            </ul>
          )
        })()}
      </div>

      {showProviderUsage ? (
        <SidebarUsagePanel providers={providerUsage} open={usagePanelOpen} onClose={() => setUsagePanelOpen(false)} loading={providerUsageLoading} onRefresh={refetchProviderUsage} />
      ) : null}

      <div className="relative shrink-0 border-t border-sidebar-border">
        {showProviderUsage ? (
          <>
            <div className="absolute inset-y-0 left-0 z-10 flex items-center justify-center" style={{ width: '38%' }}>
              <SidebarUsageRings providers={providerUsage} onToggle={() => setUsagePanelOpen(prev => !prev)} />
            </div>
            <div className="absolute top-0 bottom-0 w-px bg-sidebar-border" style={{ left: '38%' }} />
          </>
        ) : null}
        <TooltipProvider delayDuration={200}>
          <div className="flex items-center px-2 py-1.5" style={showProviderUsage ? { paddingLeft: 'calc(38% + 8px)', justifyContent: 'space-evenly' } : { justifyContent: 'center', gap: '4px' }}>
            {showPlaywrightNav ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleOpenPlaywright}
                    className={cn(
                      'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                      isPlaywrightActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                    )}
                    aria-label="Playwright"
                    aria-pressed={isPlaywrightActive}
                  >
                    <MonitorPlay aria-hidden="true" className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>Playwright</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenStats}
                  className={cn(
                    'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    isStatsActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                  )}
                  aria-label="Stats"
                  aria-pressed={isStatsActive}
                >
                  <BarChart3 aria-hidden="true" className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>Stats</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  className={cn(
                    'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    isSettingsActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
                  )}
                  aria-label="Settings"
                  aria-pressed={isSettingsActive}
                  data-tour="settings"
                >
                  <Settings aria-hidden="true" className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>Settings</TooltipContent>
            </Tooltip>
            <HelpButton />
          </div>
        </TooltipProvider>
      </div>
    </aside>
  )

  return (
    <>
      {/* Desktop: render inline */}
      <div className="hidden md:flex md:shrink-0">
        {sidebarContent}
      </div>

      {/* Mobile: render as overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 md:hidden',
          isMobileOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={cn(
            'absolute inset-0 bg-black/50 transition-opacity duration-200',
            isMobileOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={onMobileClose}
          aria-hidden="true"
        />
        <div
          className={cn(
            'relative z-10 h-full w-full transition-transform duration-200 ease-out',
            isMobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {sidebarContent}
        </div>
      </div>

      {/* Create session dialog */}
      {createTarget ? (
        <CreateSessionDialog
          profileId={createTarget.profileId}
          profileLabel={createTarget.profileLabel}
          onConfirm={handleConfirmCreateSession}
          onClose={() => setCreateTarget(null)}
        />
      ) : null}

      {/* Rename session dialog */}
      {renameTarget ? (
        <RenameSessionDialog
          agentId={renameTarget.agentId}
          currentLabel={renameTarget.label}
          onConfirm={handleConfirmRename}
          onClose={() => setRenameTarget(null)}
        />
      ) : null}

      {/* Rename profile dialog */}
      {renameProfileTarget ? (
        <RenameProfileDialog
          profileId={renameProfileTarget.profileId}
          currentName={renameProfileTarget.displayName}
          onConfirm={handleConfirmRenameProfile}
          onClose={() => setRenameProfileTarget(null)}
        />
      ) : null}

      {/* Delete session confirmation dialog */}
      {deleteTarget ? (
        <DeleteSessionDialog
          agentId={deleteTarget.agentId}
          sessionLabel={deleteTarget.label}
          onConfirm={handleConfirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}

      {/* Fork session dialog */}
      {forkTarget && onForkSession ? (
        <ForkSessionDialog
          onConfirm={(name) => {
            onForkSession(forkTarget.sourceAgentId, name)
            setForkTarget(null)
          }}
          onClose={() => setForkTarget(null)}
        />
      ) : null}

      {/* Change model dialog */}
      {changeModelTarget && onUpdateManagerModel ? (
        <ChangeModelDialog
          wsUrl={wsUrl}
          profileId={changeModelTarget.profileId}
          profileLabel={changeModelTarget.profileLabel}
          currentPreset={changeModelTarget.currentPreset}
          currentReasoningLevel={changeModelTarget.currentReasoningLevel}
          onConfirm={handleConfirmChangeModel}
          onClose={() => setChangeModelTarget(null)}
        />
      ) : null}

      {/* Change CWD dialog */}
      {changeCwdTarget && onUpdateManagerCwd && onBrowseDirectory && onValidateDirectory ? (
        <ChangeCwdDialog
          profileId={changeCwdTarget.profileId}
          profileLabel={changeCwdTarget.profileLabel}
          currentCwd={changeCwdTarget.currentCwd}
          onConfirm={handleConfirmChangeCwd}
          onClose={() => setChangeCwdTarget(null)}
          onBrowseDirectory={onBrowseDirectory}
          onValidateDirectory={onValidateDirectory}
        />
      ) : null}

      {/* Project Agent settings sheet */}
      {projectAgentTarget && onSetSessionProjectAgent ? (
        <ProjectAgentSettingsSheet
          agentId={projectAgentTarget.agentId}
          sessionLabel={projectAgentTarget.sessionLabel}
          currentProjectAgent={projectAgentTarget.currentProjectAgent}
          onSave={handleSaveProjectAgent}
          onDemote={handleDemoteProjectAgent}
          onClose={() => setProjectAgentTarget(null)}
          onGetProjectAgentConfig={onGetProjectAgentConfig}
          onListReferences={onListProjectAgentReferences}
          onGetReference={onGetProjectAgentReference}
          onSetReference={onSetProjectAgentReference}
          onDeleteReference={onDeleteProjectAgentReference}
          onRequestRecommendations={onRequestProjectAgentRecommendations}
        />
      ) : null}
    </>
  )
}
