import { useRef, useState, type FormEvent } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { secureSecretsErrorMessage } from '@/lib/secure-secrets-api'

export type BitwardenUnlockReason = 'launch' | 'secure_session'

interface BitwardenUnlockDialogProps {
  open: boolean
  providerName: string
  reason: BitwardenUnlockReason
  onUnlock: (masterPassword: string) => Promise<void>
  onDismiss: () => void
}

export function BitwardenUnlockDialog({
  open,
  providerName,
  reason,
  onUnlock,
  onDismiss,
}: BitwardenUnlockDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null)
  const [masterPassword, setMasterPassword] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearPassword = () => {
    if (passwordRef.current) passwordRef.current.value = ''
    setMasterPassword('')
  }

  const dismiss = () => {
    if (unlocking) return
    clearPassword()
    setError(null)
    onDismiss()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!masterPassword || unlocking) return
    const passwordForSubmission = masterPassword
    clearPassword()
    setError(null)
    setUnlocking(true)
    try {
      await onUnlock(passwordForSubmission)
    } catch (nextError) {
      setError(secureSecretsErrorMessage(nextError))
      requestAnimationFrame(() => passwordRef.current?.focus())
    } finally {
      setUnlocking(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss()
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-sm"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <form className="space-y-5" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" aria-hidden="true" />
              Unlock Bitwarden
            </DialogTitle>
            <DialogDescription>
              {reason === 'secure_session'
                ? `Unlock ${providerName} before Team Secure Mode starts.`
                : `${providerName} is configured for Forge and needs to be unlocked.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="forge-bitwarden-unlock-password">
              Bitwarden master password
            </Label>
            <Input
              id="forge-bitwarden-unlock-password"
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              value={masterPassword}
              onChange={(event) => setMasterPassword(event.currentTarget.value)}
              placeholder="Enter master password"
              disabled={unlocking}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Used once to unlock the local Bitwarden CLI vault. It is cleared immediately and never saved.
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
            >
              {error} Re-enter the password to try again.
            </p>
          ) : null}

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={unlocking} onClick={dismiss}>
              {reason === 'secure_session' ? 'Cancel' : 'Not now'}
            </Button>
            <Button type="submit" disabled={!masterPassword || unlocking}>
              {unlocking ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {unlocking
                ? 'Unlocking…'
                : reason === 'secure_session'
                  ? 'Unlock and start'
                  : 'Unlock'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
