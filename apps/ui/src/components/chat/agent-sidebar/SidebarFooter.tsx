import { BarChart3, CircleHelp, MonitorPlay, Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SidebarUsageRings, SidebarUsagePanel } from '../SidebarUsageWidget'
import { useHelp } from '@/components/help/help-hooks'
import { cn } from '@/lib/utils'
import type { ProviderUsageStats } from '@forge/protocol'

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

interface SidebarFooterProps {
  isSettingsActive: boolean
  isPlaywrightActive: boolean
  isStatsActive: boolean
  showPlaywrightNav: boolean
  showProviderUsage: boolean
  providerUsage: ProviderUsageStats | null
  providerUsageLoading: boolean
  usagePanelOpen: boolean
  onToggleUsagePanel: () => void
  onCloseUsagePanel: () => void
  onRefetchProviderUsage: () => void
  onOpenSettings: () => void
  onOpenPlaywright?: () => void
  onOpenStats?: () => void
}

export function SidebarFooter({
  isSettingsActive,
  isPlaywrightActive,
  isStatsActive,
  showPlaywrightNav,
  showProviderUsage,
  providerUsage,
  providerUsageLoading,
  usagePanelOpen,
  onToggleUsagePanel,
  onCloseUsagePanel,
  onRefetchProviderUsage,
  onOpenSettings,
  onOpenPlaywright,
  onOpenStats,
}: SidebarFooterProps) {
  return (
    <>
      {showProviderUsage ? (
        <SidebarUsagePanel providers={providerUsage} open={usagePanelOpen} onClose={onCloseUsagePanel} loading={providerUsageLoading} onRefresh={onRefetchProviderUsage} />
      ) : null}

      <div className="relative shrink-0 border-t border-sidebar-border">
        {showProviderUsage ? (
          <>
            <div className="absolute inset-y-0 left-0 z-10 flex items-center justify-center" style={{ width: '38%' }}>
              <SidebarUsageRings providers={providerUsage} onToggle={onToggleUsagePanel} />
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
                    onClick={onOpenPlaywright}
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
                  onClick={onOpenStats}
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
                  onClick={onOpenSettings}
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
    </>
  )
}
