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
  interactionEnabled: boolean
}

const INITIAL_PREVIEW_STATE: PreviewState = {
  status: 'idle',
  previewId: null,
  iframeSrc: null,
  errorMessage: null,
  interactionEnabled: false,
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

  // Start a preview for a session
  const startPreview = useCallback(
    async (targetSession: PlaywrightDiscoveredSession) => {
      // Release any existing preview first
      releaseCurrentPreview()

      // Check if session is previewable
      if (targetSession.liveness !== 'active') {
        setPreview({
          status: 'unavailable',
          previewId: null,
          iframeSrc: null,
          errorMessage: null,
          interactionEnabled: false,
        })
        return
      }

      setPreview({
        status: 'starting',
        previewId: null,
        iframeSrc: null,
        errorMessage: null,
        interactionEnabled: false,
      })

      try {
        const handle = await startPlaywrightLivePreview(
          wsUrl,
          targetSession.id,
          isFocusMode ? 'focus' : 'embedded',
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
          interactionEnabled: false,
        })
      } catch (err) {
        // Check if the session has changed while we were starting
        if (activeSessionIdRef.current !== targetSession.id) return

        setPreview({
          status: 'error',
          previewId: null,
          iframeSrc: null,
          errorMessage: err instanceof Error ? err.message : 'Failed to start preview',
          interactionEnabled: false,
        })
      }
    },
    [wsUrl, isFocusMode, releaseCurrentPreview],
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

  // Handle iframe error
  const handleFrameError = useCallback((message: string) => {
    setPreview((prev) => ({
      ...prev,
      status: 'error',
      errorMessage: message,
    }))
  }, [])

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
          onRetry={preview.status === 'error' || preview.status === 'expired' ? handleRetry : undefined}
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
