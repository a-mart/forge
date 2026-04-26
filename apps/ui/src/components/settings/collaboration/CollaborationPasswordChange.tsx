import { useCallback, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../settings-row'
import { changeMyPassword } from '../collaboration-settings-api'

interface CollaborationPasswordChangeProps {
  /** When true, the banner emphasises that a password change is required before continuing. */
  required?: boolean
  onChanged?: () => void
}

export function CollaborationPasswordChange({ required, onChanged }: CollaborationPasswordChangeProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const validate = useCallback((): string | null => {
    if (!currentPassword) return 'Current password is required'
    if (!newPassword) return 'New password is required'
    if (newPassword.length < 8) return 'New password must be at least 8 characters'
    if (newPassword !== confirmPassword) return 'Passwords do not match'
    if (newPassword === currentPassword) return 'New password must differ from current password'
    return null
  }, [currentPassword, newPassword, confirmPassword])

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setError(null)
      setSuccess(false)

      const validationError = validate()
      if (validationError) {
        setError(validationError)
        return
      }

      setSubmitting(true)
      try {
        await changeMyPassword(currentPassword, newPassword)
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        setSuccess(true)
        onChanged?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to change password')
      } finally {
        setSubmitting(false)
      }
    },
    [currentPassword, newPassword, validate, onChanged],
  )

  return (
    <SettingsSection
      label="Change Password"
      description={
        required
          ? 'You must change your temporary password before continuing.'
          : 'Update your collaboration account password.'
      }
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-col gap-3 px-2 py-2"
        autoComplete="off"
        data-testid="password-change-form"
      >
        {required && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            A password change is required before you can use the collaboration features.
          </div>
        )}

        {error && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="password-error"
          >
            {error}
          </div>
        )}

        {success && (
          <div
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
            data-testid="password-success"
          >
            Password changed successfully.
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="collab-current-password">Current password</Label>
          <Input
            id="collab-current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value)
              setError(null)
              setSuccess(false)
            }}
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="collab-new-password">New password</Label>
          <Input
            id="collab-new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value)
              setError(null)
              setSuccess(false)
            }}
            disabled={submitting}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="collab-confirm-password">Confirm new password</Label>
          <Input
            id="collab-confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value)
              setError(null)
              setSuccess(false)
            }}
            disabled={submitting}
          />
        </div>

        <Button type="submit" size="sm" className="w-fit" disabled={submitting}>
          {submitting ? 'Changing\u2026' : 'Change password'}
        </Button>
      </form>
    </SettingsSection>
  )
}
