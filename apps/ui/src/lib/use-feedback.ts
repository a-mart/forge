import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeedbackState } from '@/lib/feedback-types'
import { fetchFeedbackStates, submitFeedback } from '@/lib/feedback-client'

export function useFeedback(profileId: string | null, sessionId: string | null) {
  const [feedbackStates, setFeedbackStates] = useState<Map<string, FeedbackState>>(new Map())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const fetchedKeyRef = useRef<string | null>(null)

  // Fetch initial states when profileId/sessionId become available
  useEffect(() => {
    if (!profileId || !sessionId) {
      setFeedbackStates(new Map())
      fetchedKeyRef.current = null
      return
    }

    const key = `${profileId}:${sessionId}`
    if (fetchedKeyRef.current === key) return
    fetchedKeyRef.current = key

    let cancelled = false

    void (async () => {
      try {
        const states = await fetchFeedbackStates(profileId, sessionId)
        if (cancelled) return
        const map = new Map<string, FeedbackState>()
        for (const state of states) {
          map.set(state.targetId, state)
        }
        setFeedbackStates(map)
      } catch {
        // Silently ignore — feedback is non-critical UI
      }
    })()

    return () => {
      cancelled = true
    }
  }, [profileId, sessionId])

  const getVote = useCallback(
    (targetId: string): 'up' | 'down' | null => {
      return feedbackStates.get(targetId)?.value ?? null
    },
    [feedbackStates],
  )

  const submitVote = useCallback(
    async (
      scope: 'message' | 'session',
      targetId: string,
      value: 'up' | 'down',
      reasonCodes?: string[],
      comment?: string,
    ) => {
      if (!profileId || !sessionId) return

      const currentVote = feedbackStates.get(targetId)?.value ?? null

      // Toggle: clicking the same value again clears it
      // For "clear", we still send the value but the backend handles the toggle.
      // If the user clicks the same value, we optimistically clear locally.
      const isToggleOff = currentVote === value

      // Optimistic update
      setFeedbackStates((prev) => {
        const next = new Map(prev)
        if (isToggleOff) {
          // Clear the vote
          next.set(targetId, {
            targetId,
            scope,
            value: null,
            latestEventId: '',
            latestAt: new Date().toISOString(),
          })
        } else {
          next.set(targetId, {
            targetId,
            scope,
            value,
            latestEventId: '',
            latestAt: new Date().toISOString(),
          })
        }
        return next
      })

      setIsSubmitting(true)
      try {
        const event = await submitFeedback({
          profileId,
          sessionId,
          scope,
          targetId,
          value,
          reasonCodes,
          comment,
        })

        // Update with server response
        setFeedbackStates((prev) => {
          const next = new Map(prev)
          // The backend handles toggle logic and returns the resulting state.
          // If it was a toggle-off, the backend may still return the event but
          // the state endpoint will reflect null. For now, trust our optimistic state
          // but update the eventId.
          const current = next.get(targetId)
          if (current) {
            next.set(targetId, {
              ...current,
              latestEventId: event.id,
              latestAt: event.createdAt,
            })
          }
          return next
        })
      } catch {
        // Revert optimistic update on error
        setFeedbackStates((prev) => {
          const next = new Map(prev)
          if (currentVote === null) {
            next.delete(targetId)
          } else {
            const existing = next.get(targetId)
            if (existing) {
              next.set(targetId, { ...existing, value: currentVote })
            }
          }
          return next
        })
      } finally {
        setIsSubmitting(false)
      }
    },
    [profileId, sessionId, feedbackStates],
  )

  return {
    feedbackStates,
    submitVote,
    getVote,
    isSubmitting,
  }
}
