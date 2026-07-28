import { useEffect, useRef, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type {
  SecureBrowserPairingClaimResponse,
  SecureBrowserPairingRequestCreated,
} from '@forge/protocol'

interface SecureBrowserPairingDialogProps {
  onCreate: () => Promise<SecureBrowserPairingRequestCreated>
  onClaim: (
    requestId: string,
    claimSecret: string,
  ) => Promise<SecureBrowserPairingClaimResponse>
  onPaired: () => void | Promise<void>
  onClose: () => void
}

export function SecureBrowserPairingDialog({
  onCreate,
  onClaim,
  onPaired,
  onClose,
}: SecureBrowserPairingDialogProps) {
  const [pairing, setPairing] =
    useState<SecureBrowserPairingRequestCreated | null>(null)
  const [state, setState] = useState<'creating' | 'waiting' | 'denied' | 'failed'>(
    'creating',
  )
  const closedRef = useRef(false)
  const callbacksRef = useRef({ onCreate, onClaim, onPaired, onClose })

  useEffect(() => {
    callbacksRef.current = { onCreate, onClaim, onPaired, onClose }
  }, [onCreate, onClaim, onPaired, onClose])

  useEffect(() => {
    closedRef.current = false
    void callbacksRef.current.onCreate()
      .then((created) => {
        if (closedRef.current) return
        setPairing(created)
        setState('waiting')
      })
      .catch(() => {
        if (!closedRef.current) setState('failed')
      })
    return () => {
      closedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!pairing || state !== 'waiting') return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const result = await callbacksRef.current.onClaim(
          pairing.requestId,
          pairing.claimSecret,
        )
        if (cancelled) return
        if (result.status === 'approved') {
          await callbacksRef.current.onPaired()
          if (!cancelled) callbacksRef.current.onClose()
          return
        }
        if (result.status === 'denied') {
          setState('denied')
          return
        }
      } catch {
        if (!cancelled) setState('failed')
        return
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_500)
    }
    timer = window.setTimeout(() => void poll(), 500)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [pairing, state])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pair this browser</DialogTitle>
          <DialogDescription>
            Approve this browser once in Forge Desktop. The browser receives
            only revocable Secure Sessions control; it never receives the
            Desktop master capability.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/35 p-4 text-center">
          {state === 'creating' ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Creating a one-time pairing request…
            </div>
          ) : pairing && state === 'waiting' ? (
            <div className="space-y-3">
              <ShieldCheck className="mx-auto size-5 text-emerald-500" aria-hidden="true" />
              <div
                className="font-mono text-3xl font-semibold tracking-[0.28em]"
                aria-label={`Pairing code ${pairing.verificationCode}`}
              >
                {pairing.verificationCode.slice(0, 3)}{' '}
                {pairing.verificationCode.slice(3)}
              </div>
              <p className="text-xs text-muted-foreground">
                In Forge Desktop, open Settings → Secrets → Paired browsers and
                approve the request with this code. This window will continue
                automatically.
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Waiting for approval…
              </div>
            </div>
          ) : (
            <p className="text-sm text-destructive">
              {state === 'denied'
                ? 'The pairing request was denied.'
                : 'The pairing request could not be completed. Close this window and try again.'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
