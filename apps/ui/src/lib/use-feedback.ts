import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeedbackState } from '@/lib/feedback-types'
import { fetchFeedbackStates, submitFeedback } from '@/lib/feedback-client'

/** Key for vote states: targetId, key for comment states: targetId:comment */
function voteKey(targetId: string): string {
  return targetId
}
function commentKey(targetId: string): string {
  return `${targetId}:comment`
}

export function useFeedback(profileId: string | null, sessionId: string | null) {
  const [feedbackStates, setFeedbackStates] = useState<Map<string, FeedbackState>>(new Map())
  const [isSubmitting, setIsSubmitting] = useState(false)
  const fetchedKeyRef = useRef<string | null>(null)
  const feedbackStatesRef = useRef(feedbackStates)
  feedbackStatesRef.current = feedbackStates

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
          const k = state.kind === 'comment' ? commentKey(state.targetId) : voteKey(state.targetId)
          map.set(k, state)
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
      const state = feedbackStates.get(voteKey(targetId))
      if (!state) return null
      return state.value === 'up' || state.value === 'down' ? state.value : null
    },
    [feedbackStates],
  )

  const hasComment = useCallback(
    (targetId: string): boolean => {
      return feedbackStates.has(commentKey(targetId))
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

      const k = voteKey(targetId)
      const currentVote = feedbackStatesRef.current.get(k)?.value ?? null

      // Toggle: clicking the same value again clears it,
      // unless reasons/comment are provided (that's an update, not a toggle-off).
      const isToggleOff = currentVote === value && reasonCodes === undefined
      const submittedValue = isToggleOff ? 'clear' : value
      const submittedReasonCodes = isToggleOff ? [] : reasonCodes
      const submittedComment = isToggleOff ? '' : comment

      // Optimistic update
      setFeedbackStates((prev) => {
        const next = new Map(prev)
        if (isToggleOff) {
          next.set(k, {
            targetId,
            scope,
            kind: 'vote',
            value: null,
            latestEventId: '',
            latestAt: new Date().toISOString(),
          })
        } else {
          next.set(k, {
            targetId,
            scope,
            kind: 'vote',
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
          value: submittedValue,
          reasonCodes: submittedReasonCodes,
          comment: submittedComment,
        })

        setFeedbackStates((prev) => {
          const next = new Map(prev)
          const current = next.get(k)
          if (current) {
            next.set(k, {
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
            next.delete(k)
          } else {
            const existing = next.get(k)
            if (existing) {
              next.set(k, { ...existing, value: currentVote })
            }
          }
          return next
        })
      } finally {
        setIsSubmitting(false)
      }
    },
    [profileId, sessionId],
  )

  const submitComment = useCallback(
    async (
      scope: 'message' | 'session',
      targetId: string,
      commentText: string,
    ) => {
      if (!profileId || !sessionId) return

      const k = commentKey(targetId)
      const hadComment = feedbackStatesRef.current.has(k)

      // Optimistic update
      setFeedbackStates((prev) => {
        const next = new Map(prev)
        next.set(k, {
          targetId,
          scope,
          kind: 'comment',
          value: 'comment',
          latestEventId: '',
          latestAt: new Date().toISOString(),
        })
        return next
      })

      setIsSubmitting(true)
      try {
        const event = await submitFeedback({
          profileId,
          sessionId,
          scope,
          targetId,
          value: 'comment',
          reasonCodes: [],
          comment: commentText,
        })

        setFeedbackStates((prev) => {
          const next = new Map(prev)
          const current = next.get(k)
          if (current) {
            next.set(k, {
              ...current,
              latestEventId: event.id,
              latestAt: event.createdAt,
            })
          }
          return next
        })
      } catch {
        // Revert
        setFeedbackStates((prev) => {
          const next = new Map(prev)
          if (!hadComment) {
            next.delete(k)
          }
          return next
        })
      } finally {
        setIsSubmitting(false)
      }
    },
    [profileId, sessionId],
  )

  const clearComment = useCallback(
    async (scope: 'message' | 'session', targetId: string) => {
      if (!profileId || !sessionId) return

      const k = commentKey(targetId)
      const prev = feedbackStatesRef.current.get(k)

      // Optimistic
      setFeedbackStates((old) => {
        const next = new Map(old)
        next.delete(k)
        return next
      })

      setIsSubmitting(true)
      try {
        await submitFeedback({
          profileId,
          sessionId,
          scope,
          targetId,
          value: 'clear',
          reasonCodes: [],
          comment: '',
          clearKind: 'comment',
        })
      } catch {
        // Revert
        if (prev) {
          setFeedbackStates((old) => {
            const next = new Map(old)
            next.set(k, prev)
            return next
          })
        }
      } finally {
        setIsSubmitting(false)
      }
    },
    [profileId, sessionId],
  )

  return {
    feedbackStates,
    submitVote,
    submitComment,
    clearComment,
    getVote,
    hasComment,
    isSubmitting,
  }
}
