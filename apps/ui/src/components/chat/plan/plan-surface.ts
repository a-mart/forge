/** Shared max width for plan / work-graph surfaces in chat (inline card + summary). */
export const PLAN_SURFACE_WIDTH_CLASS = 'max-w-3xl'

/**
 * Dock popover width matching {@link PLAN_SURFACE_WIDTH_CLASS}.
 * `max-w-3xl` is 48rem; popovers need an explicit width rather than a max-width alone.
 * Must win over PopoverContent's base `w-72` via `cn`/`twMerge`.
 */
export const PLAN_DOCK_POPOVER_WIDTH_CLASS = 'w-[min(48rem,calc(100vw-2rem))]'

/**
 * Cap dock popover to Radix collision available height so the top is never clipped
 * (`--radix-popover-content-available-height` mirrors `--radix-popper-available-height`).
 * Pair with {@link planDockPopoverCollisionTopPx} so available height starts at the
 * chat transcript surface, not the window top.
 */
export const PLAN_DOCK_POPOVER_HEIGHT_CLASS = 'max-h-(--radix-popover-content-available-height)'

/** Landmark for the chat transcript/content area below session chrome. */
export const CHAT_TRANSCRIPT_SURFACE_ATTR = 'data-chat-transcript-surface'
export const CHAT_TRANSCRIPT_SURFACE_SELECTOR = `[${CHAT_TRANSCRIPT_SURFACE_ATTR}]`

/**
 * Collision padding top = distance from the viewport top to the transcript surface.
 * Used as Radix `collisionPadding.top` so available-height excludes the chat header.
 */
export function planDockPopoverCollisionTopPx(transcriptTop: number): number {
  if (!Number.isFinite(transcriptTop)) return 0
  return Math.max(0, Math.round(transcriptTop))
}

/**
 * Max popover height so its top stays at/below the transcript bound and its bottom
 * stays above the dock trigger (side="top" placement).
 */
export function planDockPopoverMaxHeightPx({
  collisionTop,
  availableBottom,
}: {
  collisionTop: number
  availableBottom: number
}): number {
  if (!Number.isFinite(collisionTop) || !Number.isFinite(availableBottom)) return 0
  return Math.max(0, Math.floor(availableBottom - collisionTop))
}

/**
 * Cross-browser hidden scrollbar chrome while keeping overflow scrollable
 * (same pattern as WorkerPillBar / TerminalTabBar).
 */
export const SCROLLBAR_HIDDEN_CLASS =
  '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

/** Dock popover scroll surface: wheel/touch/keyboard scrollable, scrollbar chrome hidden. */
export const PLAN_DOCK_POPOVER_SCROLL_CLASS = `overflow-x-hidden overflow-y-auto ${SCROLLBAR_HIDDEN_CLASS}`

/** PopoverContent default width from `components/ui/popover` — must not survive dock merge. */
export const POPOVER_CONTENT_BASE_WIDTH_CLASS = 'w-72'

/** Width thresholds shared by dock popover and inline work-graph surfaces. */
export function workGraphColumnCount(stageWidth: number): number {
  return stageWidth >= 620 ? 3 : stageWidth >= 430 ? 2 : 1
}
