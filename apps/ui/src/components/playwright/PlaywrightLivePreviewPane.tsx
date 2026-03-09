import { useCallback, useEffect, useRef, useState } from 'react'
import { PlaywrightLivePreviewToolbar } from './PlaywrightLivePreviewToolbar'
import { PlaywrightLivePreviewFrame } from './PlaywrightLivePreviewFrame'
import { PlaywrightLivePreviewEmptyState } from './PlaywrightLivePreviewEmptyState'
import {
  startPlaywrightLivePreview,
  releasePlaywrightLivePreview,
} from './playwright-api'
import type {
  PlaywrightDiscoveredSession,
  PlaywrightLivePreviewEmbedStatusMessage,
  PlaywrightPreviewStatus,
} from '@middleman/protocol'

interface PlaywrightLivePreviewPaneProps {
  wsUrl: string
  session: PlaywrightDiscoveredSession | null
  isFocusMode: boolean
  onToggleFocusMode: () => void
  onClose: () => void
  onBack?: () => void
}

interface PreviewState {
  status: PlaywrightPreviewStatus
  previewId: string | null
  iframeSrc: string | null
  errorMessage: string | null
  unavailableReason: string | null
  interactionEnabled: boolean
}

const INITIAL_PREVIEW_STATE: PreviewState = {
  status: 'idle',
  previewId: null,
  iframeSrc: null,
  errorMessage: null,
  unavailableReason: null,
  interactionEnabled: false,
}

/**
 * Classify a backend start-preview error into a typed status.
 *
 * This is a fallback for when the backend doesn't provide structured
 * previewability data in the session object. The primary path uses
 * session.previewability upfront.
 */
function classifyStartError(err: unknown): { status: PlaywrightPreviewStatus; message: string } {
  const message = err instanceof Error ? err.message : 'Failed to start preview'
  const lower = message.toLowerCase()

  // Broad match for previewability-related backend errors:
  // - "not previewable"
  // - "unavailable"
  // - "inactive" / "stale" liveness states
  // - "no active browser"
  // - "does not have a responsive Playwright socket"
  // - "socket not responsive" / "responsive socket"
  // - "socket" related issues generally when combined with "not"
  if (lower.includes('not previewable') || lower.includes('unavailable') ||
      lower.includes('inactive') || lower.includes('stale') ||
      lower.includes('no active browser') ||
      lower.includes('responsive') ||
      (lower.includes('socket') && (lower.includes('not') || lower.includes('no ')))) {
    return { status: 'unavailable', message }
  }
  if (lower.includes('expired') || lower.includes('lease expired')) {
    return { status: 'expired', message }
  }
  return { status: 'error', message }
}

export function PlaywrightLivePreviewPane({
  wsUrl,
  session,
  isFocusMode,
  onToggleFocusMode,
  onClose,
  onBack,
}: PlaywrightLivePreviewPaneProps) {
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW_STATE)
  const activeSessionIdRef = useRef<string | null>(null)
  const activePreviewIdRef = useRef<string | null>(null)

  // Release the current preview lease
  const releaseCurrentPreview = useCallback(() => {
    const previewId = activePreviewIdRef.current
    if (previewId) {
      activePreviewIdRef.current = null
      void releasePlaywrightLivePreview(wsUrl, previewId)
    }
  }, [wsUrl])

  // Start a preview for a session.
  // Uses session.previewability to short-circuit if backend says not previewable.
  // isFocusMode is intentionally NOT a dependency — changing layout mode must not
  // trigger a new lease. The backend lease works for both embedded and focus display.
  const startPreview = useCallback(
    async (targetSession: PlaywrightDiscoveredSession) => {
      // Release any existing preview first
      releaseCurrentPreview()

      // Use backend previewability truth to short-circuit without an API round-trip
      if (targetSession.previewability && !targetSession.previewability.previewable) {
        setPreview({
          status: 'unavailable',
          previewId: null,
          iframeSrc: null,
          errorMessage: null,
          unavailableReason: targetSession.previewability.unavailableReason,
          interactionEnabled: false,
        })
        return
      }

      setPreview({
        status: 'starting',
        previewId: null,
        iframeSrc: null,
        errorMessage: null,
        unavailableReason: null,
        interactionEnabled: false,
      })

      try {
        const handle = await startPlaywrightLivePreview(
          wsUrl,
          targetSession.id,
          'embedded',
        )

        // Check if the session has changed while we were starting
        if (activeSessionIdRef.current !== targetSession.id) {
          // Session was changed while we were starting, release the lease
          void releasePlaywrightLivePreview(wsUrl, handle.previewId)
          return
        }

        activePreviewIdRef.current = handle.previewId

        setPreview({
          status: 'active',
          previewId: handle.previewId,
          iframeSrc: handle.iframeSrc,
          errorMessage: null,
          unavailableReason: null,
          interactionEnabled: false,
        })
      } catch (err) {
        // Check if the session has changed while we were starting
        if (activeSessionIdRef.current !== targetSession.id) return

        const classified = classifyStartError(err)
        setPreview({
          status: classified.status,
          previewId: null,
          iframeSrc: null,
          errorMessage: classified.status === 'error' ? classified.message : null,
          unavailableReason: classified.status === 'unavailable' ? classified.message : null,
          interactionEnabled: false,
        })
      }
    },
    [wsUrl, releaseCurrentPreview],
  )

  // When session selection changes, start/stop preview
  useEffect(() => {
    const prevSessionId = activeSessionIdRef.current
    const newSessionId = session?.id ?? null

    if (prevSessionId === newSessionId) return

    activeSessionIdRef.current = newSessionId

    if (!session) {
      releaseCurrentPreview()
      setPreview(INITIAL_PREVIEW_STATE)
      return
    }

    void startPreview(session)
  }, [session, startPreview, releaseCurrentPreview])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      releaseCurrentPreview()
    }
  }, [releaseCurrentPreview])

  // Handle retry
  const handleRetry = useCallback(() => {
    if (session) {
      void startPreview(session)
    }
  }, [session, startPreview])

  // Handle interaction enablement
  const handleInteractionRequest = useCallback(() => {
    setPreview((prev) => ({ ...prev, interactionEnabled: true }))
  }, [])

  // Handle iframe load
  const handleFrameLoad = useCallback(() => {
    // Frame loaded successfully; status remains active
  }, [])

  const handleFrameStatusMessage = useCallback((message: PlaywrightLivePreviewEmbedStatusMessage) => {
    if (message.previewId && activePreviewIdRef.current && message.previewId !== activePreviewIdRef.current) {
      return
    }

    if (message.status === 'expired') {
      activePreviewIdRef.current = null
    }

    setPreview((prev) => {
      switch (message.status) {
        case 'active':
          return {
            ...prev,
            status: 'active',
            errorMessage: null,
            unavailableReason: null,
          }
        case 'unavailable':
          return {
            ...prev,
            status: 'unavailable',
            errorMessage: null,
            unavailableReason: message.message ?? prev.unavailableReason ?? 'Live preview is unavailable',
            interactionEnabled: false,
          }
        case 'expired':
          return {
            ...prev,
            status: 'expired',
            errorMessage: null,
            unavailableReason: null,
            interactionEnabled: false,
          }
        case 'disconnected':
          return {
            ...prev,
            status: 'disconnected',
            errorMessage: message.message ?? 'Live preview disconnected',
            unavailableReason: null,
            interactionEnabled: false,
          }
        case 'error':
          return {
            ...prev,
            status: 'error',
            errorMessage: message.message ?? 'Live preview error',
            unavailableReason: null,
            interactionEnabled: false,
          }
        default:
          return prev
      }
    })
  }, [])

  // Handle iframe error — distinguish disconnected from generic error
  const handleFrameError = useCallback((message: string) => {
    setPreview((prev) => {
      // If we had an active preview and the frame failed, it's a disconnect
      const newStatus: PlaywrightPreviewStatus =
        prev.status === 'active' ? 'disconnected' : 'error'
      return {
        ...prev,
        status: newStatus,
        errorMessage: message,
      }
    })
  }, [])

  const canRetry = preview.status === 'error' || preview.status === 'expired' || preview.status === 'disconnected'

  // Show empty state if no session or non-active preview
  if (!session || preview.status !== 'active' || !preview.iframeSrc) {
    return (
      <div className="flex h-full flex-col">
        {session ? (
          <PlaywrightLivePreviewToolbar
            session={session}
            previewStatus={preview.status}
            isFocusMode={isFocusMode}
            onToggleFocusMode={onToggleFocusMode}
            onClose={onClose}
            onBack={onBack}
          />
        ) : null}
        <PlaywrightLivePreviewEmptyState
          status={preview.status}
          sessionSelected={session !== null}
          errorMessage={preview.errorMessage}
          unavailableReason={preview.unavailableReason}
          onRetry={canRetry ? handleRetry : undefined}
        />
      </div>
    )
  }

  // Active preview with iframe
  return (
    <div className="flex h-full flex-col">
      <PlaywrightLivePreviewToolbar
        session={session}
        previewStatus={preview.status}
        isFocusMode={isFocusMode}
        onToggleFocusMode={onToggleFocusMode}
        onClose={onClose}
        onBack={onBack}
      />
      <PlaywrightLivePreviewFrame
        iframeSrc={preview.iframeSrc}
        interactionEnabled={preview.interactionEnabled}
        onInteractionRequest={handleInteractionRequest}
        onLoad={handleFrameLoad}
        onError={handleFrameError}
        onStatusMessage={handleFrameStatusMessage}
      />
    </div>
  )
}
