import {
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDashed,
  Copy,
  Edit3,
  EyeOff,
  GitFork,
  Merge,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
  Trash2,
  UserStar,
  X,
} from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { inferModelPreset } from '@/lib/model-preset'
import { cn } from '@/lib/utils'
import {
  MANAGER_MODEL_PRESETS,
  MANAGER_REASONING_LEVELS,
  type AgentContextUsage,
  type AgentDescriptor,
  type AgentStatus,
  type ManagerModelPreset,
  type ManagerReasoningLevel,
  type ManagerProfile,
} from '@middleman/protocol'

interface AgentSidebarProps {
  connected: boolean
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
  onAddManager: () => void
  onSelectAgent: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onDeleteManager: (managerId: string) => void
  onOpenSettings: () => void
  onCreateSession?: (profileId: string, name?: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onRenameSession?: (agentId: string, label: string) => void
  onForkSession?: (sourceAgentId: string, name?: string) => void
  onMergeSessionMemory?: (agentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onUpdateManagerModel?: (managerId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => void
}

type AgentLiveStatus = {
  status: AgentStatus
  pendingCount: number
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

// ── Shared components ──

function RuntimeIcon({ agent, className }: { agent: AgentDescriptor; className?: string }) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-opus') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img src="/pi-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
        <img src="/agents/claude-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain', className)} />
      </span>
    )
  }

  if (preset === 'pi-codex' || preset === 'pi-5.4') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img src="/pi-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
        <img
          src="/agents/codex-logo.svg"
          alt=""
          className={cn('size-3 shrink-0 object-contain dark:invert', className)}
        />
      </span>
    )
  }

  if (preset === 'codex-app') {
    return (
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        <img src="/agents/codex-app-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
        <img src="/agents/codex-logo.svg" alt="" className={cn('size-3 shrink-0 object-contain dark:invert', className)} />
      </span>
    )
  }

  if (provider.includes('anthropic') || provider.includes('claude')) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className={className} />
  }

  if (provider.includes('openai')) {
    return <img src="/agents/codex-logo.svg" alt="" aria-hidden="true" className={cn('dark:invert', className)} />
  }

  return <span className={cn('inline-block size-1.5 rounded-full bg-current', className)} aria-hidden="true" />
}

function getModelLabel(agent: AgentDescriptor, preset: ManagerModelPreset | undefined): string {
  if (preset === 'pi-opus') return 'opus'
  if (preset === 'pi-codex' || preset === 'pi-5.4' || preset === 'codex-app') return 'codex'
  const modelId = agent.model.modelId.trim().toLowerCase()
  if (modelId.startsWith('claude-opus')) return 'opus'
  if (modelId.includes('codex')) return 'codex'
  return agent.model.modelId
}

function AgentActivitySlot({
  isActive,
  isSelected,
  streamingWorkerCount,
}: {
  isActive: boolean
  isSelected: boolean
  streamingWorkerCount?: number
}) {
  if (streamingWorkerCount && streamingWorkerCount > 0) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
              aria-label={`${streamingWorkerCount} active worker${streamingWorkerCount !== 1 ? 's' : ''}`}
            >
              <CircleDashed
                className={cn(
                  'absolute inset-0 size-3.5 animate-spin',
                  isSelected ? 'text-sidebar-accent-foreground/80' : 'text-muted-foreground',
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'relative text-[7px] font-bold leading-none',
                  isSelected ? 'text-sidebar-accent-foreground' : 'text-muted-foreground',
                )}
              >
                {streamingWorkerCount}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
            {streamingWorkerCount} worker{streamingWorkerCount !== 1 ? 's' : ''} active
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  if (!isActive) {
    return <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />
  }

  return (
    <CircleDashed
      className={cn(
        'size-3.5 shrink-0 animate-spin',
        isSelected ? 'text-sidebar-accent-foreground/80' : 'text-muted-foreground',
      )}
      aria-label="Active"
    />
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

function slugifySessionName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function RuntimeBadge({ agent, isSelected }: { agent: AgentDescriptor; isSelected: boolean }) {
  const preset = inferModelPreset(agent)
  const modelLabel = getModelLabel(agent, preset)
  const modelDescription = `${agent.model.provider}/${agent.model.modelId}`

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'ml-1 inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar-accent/40 px-0.5',
              isSelected ? 'border-sidebar-ring/60 bg-sidebar-accent-foreground/10' : '',
            )}
          >
            <RuntimeIcon agent={agent} className="size-3 shrink-0 object-contain opacity-90" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="px-2 py-1 text-[10px]">
          <p className="font-medium">{modelLabel}</p>
          <p className="opacity-80">{modelDescription}</p>
          {agent.model.thinkingLevel && (
            <p className="opacity-60">reasoning: {agent.model.thinkingLevel}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
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
  const title = agent.displayName || agent.agentId
  const isActive = liveStatus.status === 'streaming'
  const isRunning = liveStatus.status === 'streaming' || liveStatus.status === 'idle'
  const isStopped = liveStatus.status === 'terminated' || liveStatus.status === 'stopped'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'flex w-full items-center gap-1 rounded-md py-2.5 pl-12 pr-1.5 transition-colors md:py-1',
            isSelected
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
          )}
        >
          <button
            type="button"
            onClick={onSelect}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
            title={title}
          >
            <AgentActivitySlot isActive={isActive} isSelected={isSelected} />
            <span className="min-w-0 flex-1 truncate text-sm leading-5">
              {highlightQuery ? <HighlightedText text={title} query={highlightQuery} /> : title}
            </span>
            <RuntimeBadge agent={agent} isSelected={isSelected} />
          </button>
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
  onMergeMemory,
  onMarkUnread,
  onStopWorker,
  onResumeWorker,
  highlightQuery,
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
  onMergeMemory?: () => void
  onMarkUnread?: () => void
  onStopWorker?: (agentId: string) => void
  onResumeWorker?: (agentId: string) => void
  highlightQuery?: string
}) {
  const { sessionAgent, workers, isDefault } = session
  const liveStatus = getAgentLiveStatus(sessionAgent, statuses)
  const running = isSessionRunning(sessionAgent)
  const isSelected = !isSettingsActive && selectedAgentId === sessionAgent.agentId
  const isActive = liveStatus.status === 'streaming'
  const label = sessionAgent.sessionLabel || (isDefault ? 'Main' : sessionAgent.displayName || sessionAgent.agentId)
  const streamingWorkerCount = isCollapsed
    ? workers.filter((w) => getAgentLiveStatus(w, statuses).status === 'streaming').length
    : 0
  const showUnread = unreadCount > 0 && !isSelected

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'relative flex items-center rounded-md transition-colors',
              isSelected
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/90 hover:bg-sidebar-accent/50',
            )}
          >
            {/* Expand/collapse toggle (only show if has workers) */}
            {workers.length > 0 ? (
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

            <button
              type="button"
              onClick={() => onSelect(sessionAgent.agentId)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 py-2.5 pr-1.5 text-left md:py-1.5',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                workers.length > 0 ? 'pl-7' : 'pl-5',
              )}
              title={`${label}${running ? ' (running)' : ' (idle)'}`}
            >
              <SessionStatusDot running={running} />
              {isActive || streamingWorkerCount > 0 ? (
                <AgentActivitySlot
                  isActive={isActive}
                  isSelected={isSelected}
                  streamingWorkerCount={isCollapsed ? streamingWorkerCount : undefined}
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm leading-5">
                {highlightQuery ? <HighlightedText text={label} query={highlightQuery} /> : label}
              </span>
              {showUnread ? (
                <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium tabular-nums leading-none text-white">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}

            </button>
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
          {onMergeMemory ? (
            <ContextMenuItem onClick={onMergeMemory}>
              <Merge className="mr-2 size-3.5" />
              Merge Memory
            </ContextMenuItem>
          ) : null}
          {onMarkUnread ? (
            <ContextMenuItem onClick={onMarkUnread}>
              <EyeOff className="mr-2 size-3.5" />
              Mark as unread
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
      {workers.length > 0 && !isCollapsed ? (
        <div className="relative mt-0.5">
          <div className="absolute bottom-1 left-6 top-0 w-px bg-sidebar-border/40" />
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
const MAX_VISIBLE_WORKERS = 15

function ProfileGroup({
  treeRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,
  collapsedSessionIds,
  isSessionListExpanded,
  expandedWorkerListSessionIds,
  onToggleProfileCollapsed,
  onToggleSessionCollapsed,
  onToggleSessionListExpanded,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onDeleteManager,
  onOpenSettings,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRequestRenameSession,
  onForkSession,
  onMergeSessionMemory,
  onMarkUnread,
  onChangeModel,
  highlightQuery,
}: {
  treeRow: ProfileTreeRow
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  isCollapsed: boolean
  collapsedSessionIds: Set<string>
  isSessionListExpanded: boolean
  expandedWorkerListSessionIds: Set<string>
  onToggleProfileCollapsed: () => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onToggleSessionListExpanded: () => void
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
  onForkSession?: (sourceAgentId: string) => void
  onMergeSessionMemory?: (agentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onChangeModel?: (profileId: string) => void
  highlightQuery?: string
}) {
  const { profile, sessions } = treeRow
  const hasAnySessions = sessions.length > 0
  const defaultSession = sessions.find((s) => s.isDefault)

  // Count active sessions for collapsed summary
  const activeSessionCount = sessions.filter((s) => isSessionRunning(s.sessionAgent)).length
  const totalStreamingWorkers = sessions.reduce(
    (count, s) => count + s.workers.filter((w) => getAgentLiveStatus(w, statuses).status === 'streaming').length,
    0,
  )

  // Use the default session agent for the runtime badge
  const representativeAgent = defaultSession?.sessionAgent ?? sessions[0]?.sessionAgent

  return (
    <li>
      {/* Profile header */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex items-center">
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
              <span className="relative flex h-3.5 w-3.5 items-center justify-center">
                {isCollapsed ? (
                  <>
                    <UserStar
                      aria-hidden="true"
                      className="size-3.5 opacity-70 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                    />
                    <ChevronRight
                      aria-hidden="true"
                      className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                    />
                  </>
                ) : (
                  <>
                    <UserStar
                      aria-hidden="true"
                      className="size-3.5 opacity-70 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                    />
                    <ChevronDown
                      aria-hidden="true"
                      className="absolute size-3 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
                    />
                  </>
                )}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                // Click profile header → select default session
                const targetId = defaultSession?.sessionAgent.agentId ?? sessions[0]?.sessionAgent.agentId
                if (targetId) onSelect(targetId)
              }}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-2.5 pl-7 pr-1.5 text-left transition-colors md:py-1.5',
                'hover:bg-sidebar-accent/50',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
              )}
              title={profile.displayName}
            >
              {isCollapsed && totalStreamingWorkers > 0 ? (
                <AgentActivitySlot isActive={false} isSelected={false} streamingWorkerCount={totalStreamingWorkers} />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                {profile.displayName}
              </span>
              {isCollapsed && hasAnySessions ? (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {activeSessionCount}/{sessions.length}
                </span>
              ) : null}
              {representativeAgent ? (
                <RuntimeBadge agent={representativeAgent} isSelected={false} />
              ) : null}
            </button>

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
          {onChangeModel ? (
            <ContextMenuItem onClick={() => onChangeModel(profile.profileId)}>
              <RefreshCw className="mr-2 size-3.5" />
              Change Model
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onClick={onOpenSettings}>
            <Settings className="mr-2 size-3.5" />
            Settings
          </ContextMenuItem>
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
        <div className="relative mt-0.5">
          <div className="absolute bottom-1 left-3.5 top-0 w-px bg-sidebar-border/40" />
          {(() => {
            const needsTruncation = sessions.length > MAX_VISIBLE_SESSIONS
            let visibleSessions: SessionRow[]
            let hiddenCount = 0

            if (isSessionListExpanded || !needsTruncation) {
              visibleSessions = sessions
            } else {
              // Take the top MAX_VISIBLE_SESSIONS, but guarantee the selected session is visible
              const topSessions = sessions.slice(0, MAX_VISIBLE_SESSIONS)
              const selectedSessionInTop = !selectedAgentId || isSettingsActive || topSessions.some(
                (s) =>
                  s.sessionAgent.agentId === selectedAgentId ||
                  s.workers.some((w) => w.agentId === selectedAgentId),
              )

              if (selectedSessionInTop) {
                visibleSessions = topSessions
              } else {
                // Find the selected session from the full list and swap it in
                const selectedSession = sessions.find(
                  (s) =>
                    s.sessionAgent.agentId === selectedAgentId ||
                    s.workers.some((w) => w.agentId === selectedAgentId),
                )
                if (selectedSession) {
                  visibleSessions = [...topSessions.slice(0, MAX_VISIBLE_SESSIONS - 1), selectedSession]
                } else {
                  visibleSessions = topSessions
                }
              }
              hiddenCount = sessions.length - visibleSessions.length
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {visibleSessions.map((session) => {
                    // Default is collapsed; only expanded if user explicitly opened it
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
                        onDelete={onDeleteSession ? () => onDeleteSession(session.sessionAgent.agentId) : undefined}
                        onRename={onRequestRenameSession ? () => onRequestRenameSession(session.sessionAgent.agentId) : undefined}
                        onFork={onForkSession ? () => onForkSession(session.sessionAgent.agentId) : undefined}
                        onMergeMemory={onMergeSessionMemory ? () => onMergeSessionMemory(session.sessionAgent.agentId) : undefined}
                        onMarkUnread={onMarkUnread ? () => onMarkUnread(session.sessionAgent.agentId) : undefined}
                        onStopWorker={onStopSession}
                        onResumeWorker={onResumeSession}
                        highlightQuery={highlightQuery}
                      />
                    )
                  })}
                </ul>
                {needsTruncation ? (
                  <button
                    type="button"
                    onClick={onToggleSessionListExpanded}
                    className={cn(
                      'relative z-10 mt-0.5 flex w-full items-center gap-1 rounded-md py-1 pl-5 pr-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors',
                      'hover:text-muted-foreground hover:bg-sidebar-accent/30',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    )}
                  >
                    {isSessionListExpanded ? (
                      <>
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenCount} more</span>
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

// ── Fork session dialog ──

function ForkSessionDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (name?: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')

  const trimmedName = name.trim()
  const slugPreview = slugifySessionName(trimmedName)
  const showInvalidSlugWarning = trimmedName.length > 0 && slugPreview.length === 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onConfirm(trimmedName.length > 0 ? trimmedName : undefined)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader className="mb-3">
          <DialogTitle>Fork Session</DialogTitle>
          <DialogDescription>Create a fork of this session.</DialogDescription>
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
              Fork
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

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

// ── Change model dialog ──

const CHANGE_MODEL_PRESETS = MANAGER_MODEL_PRESETS.filter(
  (preset) => preset !== 'codex-app',
)

const REASONING_LEVEL_LABELS: Record<ManagerReasoningLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
}

function ChangeModelDialog({
  profileId,
  profileLabel,
  currentPreset,
  currentReasoningLevel,
  onConfirm,
  onClose,
}: {
  profileId: string
  profileLabel: string
  currentPreset: ManagerModelPreset | undefined
  currentReasoningLevel: ManagerReasoningLevel | undefined
  onConfirm: (profileId: string, model: ManagerModelPreset, reasoningLevel?: ManagerReasoningLevel) => void
  onClose: () => void
}) {
  const [model, setModel] = useState<ManagerModelPreset>(currentPreset ?? 'pi-codex')
  const [reasoning, setReasoning] = useState<ManagerReasoningLevel>(currentReasoningLevel ?? 'xhigh')

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
                {CHANGE_MODEL_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {preset}
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
  isSessionListExpanded,
  expandedWorkerListSessionIds,
  onToggleCollapsed,
  onToggleSessionCollapsed,
  onToggleSessionListExpanded,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onOpenSettings,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRequestRenameSession,
  onForkSession,
  onMergeSessionMemory,
  onMarkUnread,
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
  isSessionListExpanded: boolean
  expandedWorkerListSessionIds: Set<string>
  onToggleCollapsed: () => void
  onToggleSessionCollapsed: (sessionId: string) => void
  onToggleSessionListExpanded: () => void
  onToggleWorkerListExpanded: (sessionId: string) => void
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onOpenSettings: () => void
  onCreateSession?: (profileId: string) => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onDeleteSession?: (agentId: string) => void
  onRequestRenameSession?: (agentId: string) => void
  onForkSession?: (sourceAgentId: string) => void
  onMergeSessionMemory?: (agentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onChangeModel?: (profileId: string) => void
  highlightQuery?: string
}) {
  const { profile, sessions } = cortexRow
  const defaultSession = sessions.find((s) => s.isDefault)
  const targetId = defaultSession?.sessionAgent.agentId ?? sessions[0]?.sessionAgent.agentId
  const isHeaderSelected = !isSettingsActive && selectedAgentId === targetId
  const hasAnySessions = sessions.length > 0

  // Unread: aggregate when collapsed, root-only when expanded
  const totalUnread = sessions.reduce(
    (sum, s) => sum + (unreadCounts[s.sessionAgent.agentId] ?? 0), 0,
  )
  const rootUnread = targetId ? (unreadCounts[targetId] ?? 0) : 0
  const displayUnread = isCollapsed ? totalUnread : rootUnread
  const showUnread = displayUnread > 0 && !isHeaderSelected

  // Activity
  const totalStreamingWorkers = sessions.reduce(
    (count, s) => count + s.workers.filter((w) => getAgentLiveStatus(w, statuses).status === 'streaming').length,
    0,
  )
  const activeSessionCount = sessions.filter((s) => isSessionRunning(s.sessionAgent)).length

  // Root session status
  const cortexAgent = defaultSession?.sessionAgent ?? sessions[0]?.sessionAgent
  const cortexStatus = cortexAgent ? getAgentLiveStatus(cortexAgent, statuses).status : null
  const cortexRunning = cortexStatus === 'idle' || cortexStatus === 'streaming'

  return (
    <div className="border-b border-sidebar-border px-2 pb-2">
      {/* Cortex header */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex items-center">
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
              {isCollapsed && totalStreamingWorkers > 0 ? (
                <AgentActivitySlot isActive={false} isSelected={false} streamingWorkerCount={totalStreamingWorkers} />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
                {profile.displayName}
              </span>
              {isCollapsed && sessions.length > 1 ? (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {activeSessionCount}/{sessions.length}
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
          {onChangeModel ? (
            <ContextMenuItem onClick={() => onChangeModel(profile.profileId)}>
              <RefreshCw className="mr-2 size-3.5" />
              Change Model
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onClick={onOpenSettings}>
            <Settings className="mr-2 size-3.5" />
            Settings
          </ContextMenuItem>
          {cortexRunning && onStopSession && targetId ? (
            <ContextMenuItem onClick={() => onStopSession(targetId)}>
              <Pause className="mr-2 size-3.5" />
              Stop Root Session
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>

      {/* Sessions list (same pattern as ProfileGroup) */}
      {!isCollapsed && hasAnySessions ? (
        <div className="relative mt-0.5">
          <div className="absolute bottom-1 left-3.5 top-0 w-px bg-sidebar-border/40" />
          {(() => {
            const needsTruncation = sessions.length > MAX_VISIBLE_SESSIONS
            let visibleSessions: SessionRow[]
            let hiddenCount = 0

            if (isSessionListExpanded || !needsTruncation) {
              visibleSessions = sessions
            } else {
              const topSessions = sessions.slice(0, MAX_VISIBLE_SESSIONS)
              const selectedSessionInTop = !selectedAgentId || isSettingsActive || topSessions.some(
                (s) =>
                  s.sessionAgent.agentId === selectedAgentId ||
                  s.workers.some((w) => w.agentId === selectedAgentId),
              )

              if (selectedSessionInTop) {
                visibleSessions = topSessions
              } else {
                const selectedSession = sessions.find(
                  (s) =>
                    s.sessionAgent.agentId === selectedAgentId ||
                    s.workers.some((w) => w.agentId === selectedAgentId),
                )
                if (selectedSession) {
                  visibleSessions = [...topSessions.slice(0, MAX_VISIBLE_SESSIONS - 1), selectedSession]
                } else {
                  visibleSessions = topSessions
                }
              }
              hiddenCount = sessions.length - visibleSessions.length
            }

            return (
              <>
                <ul className="space-y-0.5">
                  {visibleSessions.map((session) => {
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
                        onMergeMemory={onMergeSessionMemory ? () => onMergeSessionMemory(session.sessionAgent.agentId) : undefined}
                        onMarkUnread={onMarkUnread ? () => onMarkUnread(session.sessionAgent.agentId) : undefined}
                        onStopWorker={onStopSession}
                        onResumeWorker={onResumeSession}
                        highlightQuery={highlightQuery}
                      />
                    )
                  })}
                </ul>
                {needsTruncation ? (
                  <button
                    type="button"
                    onClick={onToggleSessionListExpanded}
                    className={cn(
                      'relative z-10 mt-0.5 flex w-full items-center gap-1 rounded-md py-1 pl-5 pr-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors',
                      'hover:text-muted-foreground hover:bg-sidebar-accent/30',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                    )}
                  >
                    {isSessionListExpanded ? (
                      <>
                        <ChevronUp className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show less</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                        <span>Show {hiddenCount} more</span>
                      </>
                    )}
                  </button>
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}

// ── Main sidebar ──

export function AgentSidebar({
  connected,
  agents,
  profiles,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isMobileOpen = false,
  onMobileClose,
  onAddManager,
  onSelectAgent,
  onDeleteAgent,
  onDeleteManager,
  onOpenSettings,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRenameSession,
  onForkSession,
  onMergeSessionMemory,
  onMarkUnread,
  onUpdateManagerModel,
}: AgentSidebarProps) {
  const treeRows = buildProfileTreeRows(agents, profiles)

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

  // Filter tree rows when search is active
  const { filtered: filteredTreeRows, matchCount } = useMemo(
    () => filterTreeRows(treeRows, searchQuery),
    [treeRows, searchQuery],
  )

  const [collapsedProfileIds, setCollapsedProfileIds] = useState<Set<string>>(() => new Set())
  // Track explicitly expanded sessions — everything defaults to collapsed
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  // Track which profiles have their full session list expanded (default: collapsed to MAX_VISIBLE)
  const [expandedSessionListProfileIds, setExpandedSessionListProfileIds] = useState<Set<string>>(() => new Set())
  // Track which sessions have their full worker list expanded (default: collapsed to MAX_VISIBLE_WORKERS)
  const [expandedWorkerListSessionIds, setExpandedWorkerListSessionIds] = useState<Set<string>>(() => new Set())
  const [createTarget, setCreateTarget] = useState<{ profileId: string; profileLabel: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ agentId: string; label: string } | null>(null)
  const [forkTarget, setForkTarget] = useState<{ sourceAgentId: string } | null>(null)
  const [changeModelTarget, setChangeModelTarget] = useState<{
    profileId: string
    profileLabel: string
    currentPreset: ManagerModelPreset | undefined
    currentReasoningLevel: ManagerReasoningLevel | undefined
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
      }
      return next
    })
  }, [])

  const toggleSessionListExpanded = useCallback((profileId: string) => {
    setExpandedSessionListProfileIds((prev) => {
      const next = new Set(prev)
      if (next.has(profileId)) {
        next.delete(profileId)
      } else {
        next.add(profileId)
      }
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
      }
      return next
    })
  }, [])

  const handleSelectAgent = useCallback((agentId: string) => {
    onSelectAgent(agentId)
    onMobileClose?.()
  }, [onSelectAgent, onMobileClose])

  const handleOpenSettings = useCallback(() => {
    onOpenSettings()
    onMobileClose?.()
  }, [onOpenSettings, onMobileClose])

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

  const sidebarContent = (
    <aside
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
          title="Create manager"
          aria-label="Add manager"
        >
          <SquarePen aria-hidden="true" className="h-4 w-4" />
          <span>New Manager</span>
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
            isSessionListExpanded={isSearchActive || expandedSessionListProfileIds.has('cortex')}
            expandedWorkerListSessionIds={expandedWorkerListSessionIds}
            onToggleCollapsed={() => toggleProfileCollapsed('cortex')}
            onToggleSessionCollapsed={toggleSessionCollapsed}
            onToggleSessionListExpanded={() => toggleSessionListExpanded('cortex')}
            onToggleWorkerListExpanded={toggleWorkerListExpanded}
            onSelect={handleSelectAgent}
            onDeleteAgent={onDeleteAgent}
            onOpenSettings={handleOpenSettings}
            onCreateSession={onCreateSession ? handleRequestCreateSession : undefined}
            onStopSession={onStopSession}
            onResumeSession={onResumeSession}
            onDeleteSession={handleRequestDelete}
            onRequestRenameSession={handleRequestRename}
            onForkSession={onForkSession ? (sourceAgentId: string) => setForkTarget({ sourceAgentId }) : undefined}
            onMergeSessionMemory={onMergeSessionMemory}
            onMarkUnread={onMarkUnread}
            onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
            highlightQuery={isSearchActive ? parsedSearch.term : undefined}
          />
        )
      })()}

      <div className="px-3 pb-1">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {isSearchActive ? `${matchCount} match${matchCount !== 1 ? 'es' : ''}` : 'Agents'}
        </h2>
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 pb-2 [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border [&::-webkit-scrollbar-thumb:hover]:bg-sidebar-border/80"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--sidebar-border) transparent',
        }}
      >
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

          return (
            <ul className="space-y-0.5">
              {regularRows.map((treeRow) => (
                <ProfileGroup
                  key={treeRow.profile.profileId}
                  treeRow={treeRow}
                  statuses={statuses}
                  unreadCounts={unreadCounts}
                  selectedAgentId={selectedAgentId}
                  isSettingsActive={isSettingsActive}
                  isCollapsed={isSearchActive ? false : collapsedProfileIds.has(treeRow.profile.profileId)}
                  collapsedSessionIds={expandedSessionIds}
                  isSessionListExpanded={isSearchActive || expandedSessionListProfileIds.has(treeRow.profile.profileId)}
                  expandedWorkerListSessionIds={expandedWorkerListSessionIds}
                  onToggleProfileCollapsed={() => toggleProfileCollapsed(treeRow.profile.profileId)}
                  onToggleSessionCollapsed={toggleSessionCollapsed}
                  onToggleSessionListExpanded={() => toggleSessionListExpanded(treeRow.profile.profileId)}
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
                  onForkSession={onForkSession ? (sourceAgentId: string) => setForkTarget({ sourceAgentId }) : undefined}
                  onMergeSessionMemory={onMergeSessionMemory}
                  onMarkUnread={onMarkUnread}
                  onChangeModel={onUpdateManagerModel ? handleRequestChangeModel : undefined}
                  highlightQuery={isSearchActive ? parsedSearch.term : undefined}
                />
              ))}
            </ul>
          )
        })()}
      </div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <div className="space-y-1">
          <button
            type="button"
            onClick={handleOpenSettings}
            className={cn(
              'flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
              isSettingsActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
            )}
            aria-pressed={isSettingsActive}
          >
            <Settings aria-hidden="true" className="size-4" />
            <span>Settings</span>
          </button>
        </div>
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

      {/* Rename dialog */}
      {renameTarget ? (
        <RenameSessionDialog
          agentId={renameTarget.agentId}
          currentLabel={renameTarget.label}
          onConfirm={handleConfirmRename}
          onClose={() => setRenameTarget(null)}
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
          profileId={changeModelTarget.profileId}
          profileLabel={changeModelTarget.profileLabel}
          currentPreset={changeModelTarget.currentPreset}
          currentReasoningLevel={changeModelTarget.currentReasoningLevel}
          onConfirm={handleConfirmChangeModel}
          onClose={() => setChangeModelTarget(null)}
        />
      ) : null}
    </>
  )
}
