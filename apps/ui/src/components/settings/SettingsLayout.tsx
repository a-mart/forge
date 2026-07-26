import { Activity, ArrowLeft, Bell, Settings, KeyRound, Wrench, FileText, Terminal, TerminalSquare, Puzzle, UserCog, Info, Cpu, Users, FolderGit2, Palette, GitBranch, Grid3X3, MonitorCog, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { HelpTrigger } from '@/components/help/HelpTrigger'
import { cn } from '@/lib/utils'
import type { SettingsTab } from './settings-target'

// Re-export for callers that previously imported from this module
export type { SettingsTab } from './settings-target'

interface NavItem {
  id: SettingsTab
  label: string
  icon: React.ReactNode
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general', label: 'General', icon: <Settings className="size-4" /> },
  { id: 'git-monitoring', label: 'Git monitoring', icon: <GitBranch className="size-4" /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette className="size-4" /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell className="size-4" /> },
  { id: 'auth', label: 'Authentication', icon: <KeyRound className="size-4" /> },
  { id: 'secrets', label: 'Secrets', icon: <ShieldCheck className="size-4" /> },
  { id: 'models', label: 'Models', icon: <Cpu className="size-4" /> },
  { id: 'skills', label: 'Skills', icon: <Wrench className="size-4" /> },
  { id: 'prompts', label: 'Prompts', icon: <FileText className="size-4" /> },
  { id: 'specialists', label: 'Delegation', icon: <UserCog className="size-4" /> },
  { id: 'project-resources', label: 'Repository Resources', icon: <FolderGit2 className="size-4" /> },
  { id: 'slash-commands', label: 'Slash Commands', icon: <Terminal className="size-4" /> },
  { id: 'extensions', label: 'Extensions', icon: <Puzzle className="size-4" /> },
  { id: 'external-chrome', label: 'External Chrome (Local Beta)', icon: <MonitorCog className="size-4" /> },
  { id: 'cli-access', label: 'CLI Access', icon: <TerminalSquare className="size-4" /> },
  { id: 'stream-deck', label: 'Stream Deck', icon: <Grid3X3 className="size-4" /> },
  { id: 'observability', label: 'Observability', icon: <Activity className="size-4" /> },
  { id: 'collaboration', label: 'Collaboration', icon: <Users className="size-4" /> },
  { id: 'about', label: 'About', icon: <Info className="size-4" /> },
]

interface SettingsLayoutProps {
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onBack?: () => void
  children: React.ReactNode
  /** Override the max-width class on the content area. Defaults to 'max-w-3xl'. */
  contentWidthClassName?: string
  /** Filter nav items to only these tabs. When omitted, all tabs are shown. */
  availableTabs?: SettingsTab[]
  /** Non-interactive target badge label (e.g. "Builder backend" or "Collab backend"). */
  targetLabel?: string
  /**
   * When true the content area becomes a flex column that fills remaining space
   * without its own scroll. Children are expected to manage their own scrolling.
   * Used by the Skills tab whose explorer panels each scroll independently.
   */
  fillHeight?: boolean
}

export function SettingsLayout({ activeTab, onTabChange, onBack, children, contentWidthClassName, availableTabs, targetLabel, fillHeight }: SettingsLayoutProps) {
  const visibleItems = availableTabs
    ? NAV_ITEMS.filter((item) => availableTabs.includes(item.id))
    : NAV_ITEMS

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-[62px] shrink-0 items-center border-b border-border/80 bg-card/80 px-2 backdrop-blur md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
              onClick={onBack}
              aria-label="Back to chat"
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <h1 className="truncate text-sm font-semibold text-foreground">Settings</h1>
          {targetLabel ? (
            <Badge variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">
              {targetLabel}
            </Badge>
          ) : null}
        </div>
        <HelpTrigger contextKey={`settings.${activeTab}`} size="sm" variant="ghost" />
      </header>

      {/* Mobile: horizontal scrolling tab bar */}
      <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-card/30 px-2 py-1.5 md:hidden">
        {visibleItems.map((item) => {
          const isActive = activeTab === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              className={cn(
                'flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                'hover:bg-muted/50',
                isActive
                  ? 'bg-muted text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="flex shrink-0">{item.icon}</span>
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop: left nav */}
        <nav className="hidden w-48 shrink-0 border-r border-border/60 bg-card/30 md:block">
          <div className="flex flex-col gap-0.5 p-2 pt-3">
            {visibleItems.map((item) => {
              const isActive = activeTab === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onTabChange(item.id)}
                  className={cn(
                    'flex items-center gap-2 px-3 h-8 text-sm rounded-md transition-colors w-full text-left',
                    'hover:bg-muted/50',
                    isActive
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="flex shrink-0">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content area */}
        <div
          className={cn(
            'min-h-0 flex-1',
            fillHeight
              ? 'flex flex-col overflow-hidden'
              : cn(
                  'overflow-y-auto',
                  '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent',
                  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent',
                  '[scrollbar-width:thin] [scrollbar-color:transparent_transparent]',
                  'hover:[&::-webkit-scrollbar-thumb]:bg-border hover:[scrollbar-color:var(--color-border)_transparent]',
                ),
          )}
        >
          <div className={cn(
            fillHeight
              ? 'flex min-h-0 flex-1 flex-col px-4 py-4 md:px-6 md:py-5'
              : cn('mx-auto px-4 py-4 md:px-6 md:py-5', contentWidthClassName || 'max-w-3xl'),
          )}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
