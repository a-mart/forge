import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import { getMutedAgents, MUTE_CHANGE_EVENT, setMutedAgents, toggleMute } from '@/lib/notification-service'
import { cn } from '@/lib/utils'
import { MAX_VISIBLE_SESSIONS, SESSION_PAGE_SIZE } from './constants'
import { CortexSection } from './CortexSection'
import type { StatusMap } from './types'

interface CortexRailItemProps {
  cortexRow: ProfileTreeRow | null
  statuses: StatusMap
  unreadCounts: Record<string, number>
  selectedAgentId: string | null
  isSettingsActive: boolean
  onSelect: (agentId: string) => void
  onDeleteAgent: (agentId: string) => void
  onOpenSettings: () => void
  onStopSession?: (agentId: string) => void
  onResumeSession?: (agentId: string) => void
  onMarkUnread?: (agentId: string) => void
  onMarkAllRead?: (profileId: string) => void
  onRequestSessionWorkers?: (sessionId: string) => void
}

/**
 * The desktop Rooms rail entry deliberately renders the existing Cortex
 * navigator in a popover rather than replacing it with a root-session link.
 * Its view state is local to this secondary navigator; selection and actions
 * remain routed through the same callbacks as the sidebar/mobile navigator.
 */
export function CortexRailItem({
  cortexRow,
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  onSelect,
  onDeleteAgent,
  onOpenSettings,
  onStopSession,
  onResumeSession,
  onMarkUnread,
  onMarkAllRead,
  onRequestSessionWorkers,
}: CortexRailItemProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())
  const [expandedWorkerListSessionIds, setExpandedWorkerListSessionIds] = useState<Set<string>>(() => new Set())
  const [sessionListLimit, setSessionListLimit] = useState(MAX_VISIBLE_SESSIONS)
  const [mutedAgents, setMutedAgentsState] = useState<Set<string>>(() => getMutedAgents())

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      triggerRef.current?.focus()
    }
    wasOpenRef.current = open
  }, [open])

  useEffect(() => {
    const updateMuted = () => setMutedAgentsState(getMutedAgents())
    window.addEventListener(MUTE_CHANGE_EVENT, updateMuted)
    window.addEventListener('storage', updateMuted)
    return () => {
      window.removeEventListener(MUTE_CHANGE_EVENT, updateMuted)
      window.removeEventListener('storage', updateMuted)
    }
  }, [])

  const toggleSessionCollapsed = useCallback((sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
        onRequestSessionWorkers?.(sessionId)
      }
      return next
    })
  }, [onRequestSessionWorkers])

  const toggleWorkerListExpanded = useCallback((sessionId: string) => {
    setExpandedWorkerListSessionIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
        onRequestSessionWorkers?.(sessionId)
      }
      return next
    })
  }, [onRequestSessionWorkers])

  const handleMuteAllSessions = useCallback((sessionAgentIds: string[], mute: boolean) => {
    const next = getMutedAgents()
    for (const agentId of sessionAgentIds) {
      if (mute) next.add(agentId)
      else next.delete(agentId)
    }
    setMutedAgents(next)
  }, [])

  if (!cortexRow) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              className={cn(
                'sidebar-room-cortex-rail-trigger inline-flex size-[34px] items-center justify-center rounded-[11px] border transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
                open && 'sidebar-room-cortex-rail-trigger--open',
              )}
              aria-label="Cortex"
              aria-expanded={open}
              aria-haspopup="dialog"
              data-testid="cortex-rail-trigger"
            >
              <Brain aria-hidden="true" className="size-[17px]" strokeWidth={1.6} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>Cortex</TooltipContent>
      </Tooltip>

      <PopoverContent
        side="right"
        align="end"
        sideOffset={10}
        className="max-h-[min(32rem,calc(100vh-1rem))] overflow-y-auto p-0"
        aria-label="Cortex navigator"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          triggerRef.current?.focus()
        }}
      >
        <CortexSection
          cortexRow={cortexRow}
          statuses={statuses}
          unreadCounts={unreadCounts}
          selectedAgentId={selectedAgentId}
          isSettingsActive={isSettingsActive}
          isCollapsed={isCollapsed}
          collapsedSessionIds={expandedSessionIds}
          visibleSessionLimit={sessionListLimit}
          expandedWorkerListSessionIds={expandedWorkerListSessionIds}
          onToggleCollapsed={() => setIsCollapsed((value) => !value)}
          onToggleSessionCollapsed={toggleSessionCollapsed}
          onShowMoreSessions={() => setSessionListLimit((value) => value + SESSION_PAGE_SIZE)}
          onShowLessSessions={() => setSessionListLimit(MAX_VISIBLE_SESSIONS)}
          onToggleWorkerListExpanded={toggleWorkerListExpanded}
          onSelect={onSelect}
          onDeleteAgent={onDeleteAgent}
          onOpenSettings={onOpenSettings}
          onStopSession={onStopSession}
          onResumeSession={onResumeSession}
          onMarkUnread={onMarkUnread}
          onMarkAllRead={onMarkAllRead}
          mutedAgents={mutedAgents}
          onToggleMute={toggleMute}
          onMuteAllSessions={handleMuteAllSessions}
          className="border-0 px-1 pb-1"
        />
      </PopoverContent>
    </Popover>
  )
}
