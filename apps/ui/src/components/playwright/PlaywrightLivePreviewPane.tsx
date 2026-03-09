import { useCallback, useEffect, useRef, useState } from 'react'
import { PlaywrightLivePreviewToolbar } from './PlaywrightLivePreviewToolbar'
import { PlaywrightLivePreviewFrame } from './PlaywrightLivePreviewFrame'
import { PlaywrightLivePreviewEmptyState } from './PlaywrightLivePreviewEmptyState'
import {
  startPlaywrightLivePreview,
  releasePlaywrightLivePreview,
  resolvePreviewIframeSrc,
} from './playwright-api'
import type {
  PlaywrightDiscoveredSession,
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

/** Parse backend error responses for structured unavailable/expired signals */
function classifyStartError(err: unknown): { status: PlaywrightPreviewStatus; message: string } {
  const message = err instanceof Error ? err.message : 'Failed to start preview'
  const lower = message.toLowerCase()

  // Backend may return specific reasons the session is not previewable
  if (lower.includes('not previewable') || lower.includes('unavailable') ||
      lower.includes('inactive') || lower.includes('stale') ||
      lower.includes('no active browser') || lower.includes('socket not responsive')) {
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
  // Previewability is determined by the backend, not client-side liveness checks.
  // isFocusMode is intentionally NOT a dependency — changing layout mode must not
  // trigger a new lease. The backend lease works for both embedded and focus display.
  const startPreview = useCallback(
    async (targetSession: PlaywrightDiscoveredSession) => {
      // Release any existing preview first
      releaseCurrentPreview()

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
        const iframeSrc = resolvePreviewIframeSrc(wsUrl, handle.previewId)

        setPreview({
          status: 'active',
          previewId: handle.previewId,
          iframeSrc,
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
      />
    </div>
  )
}
