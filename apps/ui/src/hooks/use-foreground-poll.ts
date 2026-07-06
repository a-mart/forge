/**
 * Foreground polling policy (WP-U3, roadmap 3.8).
 *
 * One shared hook for the app's data-fetch polls so cadence and
 * visibility-pause are consistent instead of each poller re-implementing its
 * own `setInterval` / self-rescheduling `setTimeout` with different
 * pause-when-hidden behavior.  Previously `use-backend-health-poll` used a bare
 * `setInterval` with no visibility pause while `use-provider-usage` used a
 * self-rescheduling timeout that paused when hidden — this unifies both on the
 * same policy.
 *
 * Policy (the union of what the prior pollers needed):
 *   - Run once immediately on mount (when enabled).
 *   - After each run completes, schedule the next run `intervalMs` later
 *     (self-rescheduling — no overlapping in-flight polls).
 *   - Pause while the document is hidden: clear the pending timer and abort the
 *     in-flight request; on becoming visible again, run immediately and resume.
 *   - Each run receives an `AbortSignal` that is aborted on unmount, on the
 *     next run, and when the tab is hidden, so a poll fn can cancel its fetch.
 *
 * The returned `refetch` triggers an immediate run (and reschedules from there),
 * matching the manual-refresh affordance `use-provider-usage` exposes.
 *
 * Not for per-component elapsed-time tickers (MessageList / ToolLogRow /
 * WorkerPillBar 1s display counters) — those are render-only UI clocks, not
 * data polls, and are intentionally out of scope here.
 */

import { useCallback, useEffect, useRef } from 'react'

export interface ForegroundPollOptions {
  /** Delay between the end of one run and the start of the next. */
  intervalMs: number
  /**
   * When `false`, no polling runs and any in-flight poll is torn down.
   * Defaults to `true`.
   */
  enabled?: boolean
}

export interface ForegroundPollHandle {
  /** Run the poll now and reschedule the interval from this point. */
  refetch: () => void
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/**
 * Drive `poll` on the shared foreground-poll policy.
 *
 * `poll` should be stable (wrap in `useCallback`) or the effect will restart
 * when its identity changes — restarting triggers an immediate run, which is
 * the desired behavior when the underlying target/inputs change.
 */
export function useForegroundPoll(
  poll: (signal: AbortSignal) => Promise<void>,
  options: ForegroundPollOptions,
): ForegroundPollHandle {
  const { intervalMs, enabled = true } = options
  // Expose the live runner to the stable `refetch` without re-running the effect.
  const runRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled) {
      runRef.current = null
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    const scheduleNext = () => {
      clearTimer()
      if (cancelled || isDocumentHidden()) return
      timer = setTimeout(() => {
        void run()
      }, intervalMs)
    }

    const run = async () => {
      controller?.abort()
      controller = new AbortController()
      try {
        await poll(controller.signal)
      } finally {
        if (!cancelled) scheduleNext()
      }
    }

    runRef.current = () => {
      void run()
    }

    const handleVisibilityChange = () => {
      if (isDocumentHidden()) {
        clearTimer()
        controller?.abort()
        controller = null
        return
      }
      // Became visible → poll immediately and resume the schedule.
      void run()
    }

    void run()

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      cancelled = true
      runRef.current = null
      clearTimer()
      controller?.abort()
      controller = null
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
    }
  }, [poll, intervalMs, enabled])

  const refetch = useCallback(() => {
    runRef.current?.()
  }, [])

  return { refetch }
}
