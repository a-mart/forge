import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../settings-row'
import {
  fetchCollaborationUsers,
  resetUserPassword,
  updateCollaborationUser,
  isAuthError,
} from '../collaboration-settings-api'
import type { CollaborationUser } from '@forge/protocol'

interface CollaborationMembersProps {
  currentUserId: string
  onAuthError?: () => void
}

export function CollaborationMembers({ currentUserId, onAuthError }: CollaborationMembersProps) {
  const [users, setUsers] = useState<CollaborationUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Password reset dialog
  const [resetTarget, setResetTarget] = useState<CollaborationUser | null>(null)
  const [tempPassword, setTempPassword] = useState('')
  const [tempPasswordConfirm, setTempPasswordConfirm] = useState('')
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  // Inline action feedback
  const [actionError, setActionError] = useState<string | null>(null)

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCollaborationUsers()
      setUsers(data)
    } catch (err) {
      if (isAuthError(err)) {
        onAuthError?.()
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [onAuthError])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  const handleRoleChange = useCallback(
    async (user: CollaborationUser, newRole: 'admin' | 'member') => {
      setActionError(null)
      try {
        const updated = await updateCollaborationUser(user.userId, { role: newRole })
        setUsers((prev) => prev.map((u) => (u.userId === updated.userId ? updated : u)))
      } catch (err) {
        if (isAuthError(err)) {
          onAuthError?.()
          return
        }
        setActionError(err instanceof Error ? err.message : 'Failed to update role')
      }
    },
    [onAuthError],
  )

  const handleToggleActive = useCallback(
    async (user: CollaborationUser) => {
      setActionError(null)
      try {
        const updated = await updateCollaborationUser(user.userId, { disabled: !user.disabled })
        setUsers((prev) => prev.map((u) => (u.userId === updated.userId ? updated : u)))
      } catch (err) {
        if (isAuthError(err)) {
          onAuthError?.()
          return
        }
        setActionError(err instanceof Error ? err.message : 'Failed to update user')
      }
    },
    [onAuthError],
  )

  const handlePasswordReset = useCallback(async () => {
    if (!resetTarget) return
    setResetError(null)

    if (!tempPassword) {
      setResetError('Temporary password is required')
      return
    }
    if (tempPassword.length < 8) {
      setResetError('Password must be at least 8 characters')
      return
    }
    if (tempPassword !== tempPasswordConfirm) {
      setResetError('Passwords do not match')
      return
    }

    setResetting(true)
    try {
      await resetUserPassword(resetTarget.userId, tempPassword)
      setResetTarget(null)
      setTempPassword('')
      setTempPasswordConfirm('')
    } catch (err) {
      if (isAuthError(err)) {
        onAuthError?.()
        return
      }
      setResetError(err instanceof Error ? err.message : 'Failed to reset password')
    } finally {
      setResetting(false)
    }
  }, [resetTarget, tempPassword, tempPasswordConfirm, onAuthError])

  return (
    <>
      <SettingsSection label="Members" description="Manage collaboration team members.">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3">
            <span className="text-sm text-muted-foreground">Loading members\u2026</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-2 py-3">
            <span className="text-sm text-destructive">{error}</span>
            <button
              type="button"
              onClick={() => void loadUsers()}
              className="text-xs text-primary underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1" data-testid="members-list">
            {actionError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive mb-2">
                {actionError}
              </div>
            )}

            {users.map((user) => {
              const isSelf = user.userId === currentUserId
              return (
                <div
                  key={user.userId}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                  data-testid={`member-row-${user.userId}`}
                >
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {user.name || user.email}
                        {isSelf && (
                          <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                        )}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge
                      variant="secondary"
                      className="px-2 py-0 text-[10px] uppercase"
                    >
                      {user.role}
                    </Badge>
                    {user.disabled && (
                      <Badge
                        variant="destructive"
                        className="px-2 py-0 text-[10px] uppercase"
                      >
                        Deactivated
                      </Badge>
                    )}

                    {!isSelf && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            aria-label={`Actions for ${user.name || user.email}`}
                          >
                            <span className="sr-only">Actions</span>
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="12" cy="12" r="1" />
                              <circle cx="12" cy="5" r="1" />
                              <circle cx="12" cy="19" r="1" />
                            </svg>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {user.role === 'member' ? (
                            <DropdownMenuItem
                              onClick={() => void handleRoleChange(user, 'admin')}
                            >
                              Promote to Admin
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => void handleRoleChange(user, 'member')}
                            >
                              Demote to Member
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {user.disabled ? (
                            <DropdownMenuItem
                              onClick={() => void handleToggleActive(user)}
                            >
                              Reactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => void handleToggleActive(user)}
                              className="text-destructive focus:text-destructive"
                            >
                              Deactivate
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              setResetTarget(user)
                              setTempPassword('')
                              setTempPasswordConfirm('')
                              setResetError(null)
                            }}
                          >
                            Reset password
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              )
            })}

            {users.length === 0 && (
              <div className="px-2 py-3 text-sm text-muted-foreground">No members found.</div>
            )}
          </div>
        )}
      </SettingsSection>

      {/* Password reset dialog */}
      <Dialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null)
            setTempPassword('')
            setTempPasswordConfirm('')
            setResetError(null)
          }
        }}
      >
        <DialogContent data-testid="password-reset-dialog">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a temporary password for{' '}
              <strong>{resetTarget?.name || resetTarget?.email}</strong>. They will be required to
              change it on next sign-in.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            {resetError && (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="reset-password-error"
              >
                {resetError}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="temp-password">Temporary password</Label>
              <Input
                id="temp-password"
                type="password"
                autoComplete="new-password"
                value={tempPassword}
                onChange={(e) => {
                  setTempPassword(e.target.value)
                  setResetError(null)
                }}
                disabled={resetting}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="temp-password-confirm">Confirm password</Label>
              <Input
                id="temp-password-confirm"
                type="password"
                autoComplete="new-password"
                value={tempPasswordConfirm}
                onChange={(e) => {
                  setTempPasswordConfirm(e.target.value)
                  setResetError(null)
                }}
                disabled={resetting}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetTarget(null)}
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handlePasswordReset()}
              disabled={resetting}
            >
              {resetting ? 'Resetting\u2026' : 'Reset password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
