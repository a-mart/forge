import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { SettingsApiClient } from './settings-api-client'
import { fetchKnowledgeV2Settings, updateKnowledgeV2Settings } from './knowledge-v2-api'
import { CORTEX_V2_COPY, CORTEX_V2_ONBOARDING_SEEN_KEY } from './cortex-v2-copy'

/**
 * First-launch onboarding for the new Cortex (Knowledge v2).
 *
 * Trigger + conditions:
 * - Shown at most ONCE per browser profile.  A `localStorage` marker
 *   (`CORTEX_V2_ONBOARDING_SEEN_KEY` = "forge.cortexV2OnboardingSeen") records
 *   that the user has decided/dismissed, so it never nags again.
 * - On mount, if the marker is already set, nothing renders (no network call).
 * - Otherwise it loads `GET /api/settings/knowledge-v2`.  It does NOT show and
 *   marks the user as decided when the feature is already enabled or when the
 *   endpoint is unavailable (404 → non-Builder runtime) or errors.
 * - Choosing "Enable new Cortex" issues `PUT { enabled: true }`; "Not now"
 *   simply closes.  Either action sets the seen marker.
 */

export function hasSeenCortexV2Onboarding(): boolean {
  try {
    return localStorage.getItem(CORTEX_V2_ONBOARDING_SEEN_KEY) === 'true'
  } catch {
    // If localStorage is unavailable, treat as "seen" so we never nag.
    return true
  }
}

export function markCortexV2OnboardingSeen(): void {
  try {
    localStorage.setItem(CORTEX_V2_ONBOARDING_SEEN_KEY, 'true')
  } catch {
    // Ignore localStorage write failures.
  }
}

interface CortexV2OnboardingModalProps {
  /** Builder settings client or raw wsUrl. */
  source: SettingsApiClient | string
}

export function CortexV2OnboardingModal({ source }: CortexV2OnboardingModalProps) {
  const [open, setOpen] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guard against double-decide across the async gate + StrictMode double-mount.
  const decidedRef = useRef(false)

  const decide = useCallback(() => {
    if (decidedRef.current) return
    decidedRef.current = true
    markCortexV2OnboardingSeen()
  }, [])

  useEffect(() => {
    if (hasSeenCortexV2Onboarding()) return
    let cancelled = false
    void fetchKnowledgeV2Settings(source)
      .then((result) => {
        if (cancelled) return
        // Not offered here (non-Builder) or already enabled → never prompt.
        if (!result.available || result.response.settings.enabled) {
          decide()
          return
        }
        setOpen(true)
      })
      .catch(() => {
        if (cancelled) return
        // On load failure, don't nag now, but leave the marker unset so a later
        // launch (once the backend is reachable) can still offer it.
      })
    return () => {
      cancelled = true
    }
  }, [source, decide])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) return
      // Any close (X, overlay, Esc, "Not now") counts as a decision.
      decide()
      setOpen(false)
    },
    [decide],
  )

  const handleEnable = useCallback(() => {
    if (enabling) return
    setEnabling(true)
    setError(null)
    void updateKnowledgeV2Settings(source, { enabled: true })
      .then(() => {
        decide()
        setOpen(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : CORTEX_V2_COPY.onboarding.enableError)
      })
      .finally(() => {
        setEnabling(false)
      })
  }, [enabling, source, decide])

  const handleDismiss = useCallback(() => {
    decide()
    setOpen(false)
  }, [decide])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{CORTEX_V2_COPY.onboarding.title}</DialogTitle>
          <DialogDescription>{CORTEX_V2_COPY.onboarding.description}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{CORTEX_V2_COPY.onboarding.revertNote}</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={handleDismiss} disabled={enabling}>
            {CORTEX_V2_COPY.onboarding.dismiss}
          </Button>
          <Button onClick={handleEnable} disabled={enabling}>
            {CORTEX_V2_COPY.onboarding.enable}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
