import type { SleepBlockerStatus } from './sleep-blocker.js'
import {
  sendToRendererWindow,
  type RendererIpcWindow,
} from './renderer-ipc.js'

const SLEEP_BLOCKER_STATUS_CHANNEL = 'sleep-blocker-status'

export type SleepBlockerStatusWindow = RendererIpcWindow

export function sendSleepBlockerStatusToWindow(
  window: SleepBlockerStatusWindow | null | undefined,
  status: SleepBlockerStatus,
): boolean {
  return sendToRendererWindow(window, SLEEP_BLOCKER_STATUS_CHANNEL, status)
}
