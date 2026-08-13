import { BarChart3, CircleHelp, Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SidebarUsageRings, SidebarUsagePanel } from '../SidebarUsageWidget'
import { useHelp } from '@/components/help/help-hooks'
import { cn } from '@/lib/utils'
import type { ProviderUsageStats } from '@forge/protocol'

function HelpButton({ roomsV2 = false }: { roomsV2?: boolean }) {
  const { isDrawerOpen, openDrawer } = useHelp()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openDrawer('chat.main')}
          className={cn(
            roomsV2
              ? 'inline-flex size-7 items-center justify-center rounded-[8px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60'
              : 'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60',
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

interface SidebarFooterProps {
  isSettingsActive: boolean
  isStatsActive: boolean
  /** Rooms-only footer layout; Classic remains byte-for-byte in its established branch. */
  roomsV2?: boolean
  showProviderUsage: boolean
  providerUsage: ProviderUsageStats | null
  providerUsageLoading: boolean
  usagePanelOpen: boolean
  onToggleUsagePanel: () => void
  onCloseUsagePanel: () => void
  onRefetchProviderUsage: () => void
  onOpenSettings: () => void
  onOpenStats?: () => void
}

export function SidebarFooter({
  isSettingsActive,
  isStatsActive,
  roomsV2 = false,
  showProviderUsage,
  providerUsage,
  providerUsageLoading,
  usagePanelOpen,
  onToggleUsagePanel,
  onCloseUsagePanel,
  onRefetchProviderUsage,
  onOpenSettings,
  onOpenStats,
}: SidebarFooterProps) {
  const usageSplit = roomsV2 ? '52%' : '38%'
  const controlClass = roomsV2
    ? 'inline-flex size-7 items-center justify-center rounded-[8px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60'
    : 'inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60'

  return (
    <>
      {showProviderUsage ? (
        <SidebarUsagePanel providers={providerUsage} open={usagePanelOpen} onClose={onCloseUsagePanel} loading={providerUsageLoading} onRefresh={onRefetchProviderUsage} />
      ) : null}

      <TooltipProvider delayDuration={200}>
        <div className="relative shrink-0 border-t border-sidebar-border" data-testid={roomsV2 ? 'rooms-sidebar-footer' : undefined}>
          {showProviderUsage ? (
            <>
              <div className="absolute inset-y-0 left-0 z-10 flex items-center justify-center" style={{ width: usageSplit }}>
                <SidebarUsageRings providers={providerUsage} onToggle={onToggleUsagePanel} roomsV2={roomsV2} />
              </div>
              <div className="absolute top-0 bottom-0 w-px bg-sidebar-border" style={{ left: usageSplit }} />
            </>
          ) : null}
          <div
            className={cn('flex items-center px-2 py-1.5', roomsV2 && 'py-1')}
            style={showProviderUsage
              ? { paddingLeft: `calc(${usageSplit} + 8px)`, justifyContent: 'space-evenly' }
              : { justifyContent: 'center', gap: '4px' }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenStats}
                  className={cn(
                    controlClass,
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
                  onClick={onOpenSettings}
                  className={cn(
                    controlClass,
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
            <HelpButton roomsV2={roomsV2} />
          </div>
        </div>
      </TooltipProvider>
    </>
  )
}
