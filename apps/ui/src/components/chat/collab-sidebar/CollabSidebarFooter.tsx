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
import type { CollaborationBootstrapCurrentUser } from '@forge/protocol'

interface CollabSidebarFooterProps {
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

export function CollabSidebarFooter({ wsUrl, currentUser }: CollabSidebarFooterProps) {
  const [isSigningOut, setIsSigningOut] = useState(false)

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
    <div className="border-t border-sidebar-border px-3 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent/50"
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
              {getInitial(currentUser)}
            </div>
            <span className="min-w-0 truncate text-sm text-sidebar-foreground">
              {displayName}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-56 p-3">
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
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
