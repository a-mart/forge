import { useMemo, useState } from 'react'
import { LogOut } from 'lucide-react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CollaborationBootstrapCurrentUser } from '@forge/protocol'

interface UserAvatarPopoverProps {
  wsUrl: string
  currentUser: CollaborationBootstrapCurrentUser | null
}

function getInitial(user: CollaborationBootstrapCurrentUser | null): string {
  if (!user) {
    return '?'
  }

  const source = user.name || user.email || ''
  return source.charAt(0).toUpperCase() || '?'
}

export function UserAvatarPopover({ wsUrl, currentUser }: UserAvatarPopoverProps) {
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [open, setOpen] = useState(false)

  const displayName = useMemo(() => {
    if (!currentUser) {
      return 'Not signed in'
    }

    return currentUser.name || currentUser.email
  }, [currentUser])

  const handleSignOut = async () => {
    if (isSigningOut) {
      return
    }

    setIsSigningOut(true)
    try {
      await fetch(resolveApiEndpoint(wsUrl, '/api/auth/sign-out'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
    } catch {
      // Best-effort sign out. Reload either way so auth state is re-evaluated.
    } finally {
      window.location.reload()
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/60"
              aria-label={displayName ?? 'User profile'}
            >
              <div className="flex size-6 items-center justify-center rounded-full bg-sidebar-accent text-[10px] font-semibold text-sidebar-foreground">
                {getInitial(currentUser)}
              </div>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>Profile</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="w-56 p-3">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="truncate text-sm font-medium">{displayName}</p>
            {currentUser?.email ? (
              <p className="truncate text-xs text-muted-foreground">{currentUser.email}</p>
            ) : null}
            {currentUser ? (
              <Badge variant="secondary" className="mt-1 px-2 py-0 text-[10px] uppercase">
                {currentUser.role}
              </Badge>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start gap-2 px-2 text-xs text-muted-foreground hover:text-sidebar-foreground"
            onClick={handleSignOut}
            disabled={isSigningOut}
            aria-label="Sign out"
          >
            <LogOut className="size-3.5" />
            {isSigningOut ? 'Signing out...' : 'Sign out'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
