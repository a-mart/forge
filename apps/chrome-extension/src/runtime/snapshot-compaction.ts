import {
  EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES,
  type BrowserAutomationResultByOperation,
  type BrowserSnapshotResult,
  type ExternalChromeExecuteResult,
} from '@forge/protocol'

const MAX_VISIBLE_TEXT_AFTER_COMPACTION = 4_096
const MAX_ACCESSIBILITY_NODES_AFTER_COMPACTION = 24

type SnapshotExecuteResult = Extract<ExternalChromeExecuteResult, { operation: 'snapshot'; ok: true }>

type OmittedCounts = NonNullable<BrowserSnapshotResult['compaction']>['omitted']

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function jsonRpcResponseBytes(id: string, result: unknown): number {
  return utf8Bytes(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function countAccessibilityNodes(value: unknown): number {
  const root = record(value)
  if (!root || !Array.isArray(root.frames)) return 0
  return root.frames.reduce((count, frame) => count + (Array.isArray(record(frame)?.nodes) ? (record(frame)?.nodes as unknown[]).length : 0), 0)
}

function compactedResult(snapshot: BrowserSnapshotResult, omitted: OmittedCounts): BrowserSnapshotResult {
  const entries = Object.entries(omitted).filter(([, count]) => count > 0)
  return entries.length === 0
    ? snapshot
    : { ...snapshot, compaction: { omitted: Object.fromEntries(entries) as OmittedCounts } }
}

function snapshotResponse(result: unknown): SnapshotExecuteResult | null {
  const execute = record(result)
  if (execute?.ok !== true || execute.operation !== 'snapshot') return null
  const snapshot = record(execute.result)
  if (!snapshot) return null
  return execute as unknown as SnapshotExecuteResult
}

function failureForScreenshotOverflow(execute: SnapshotExecuteResult, screenshotBytes: number, maximumBytes: number): ExternalChromeExecuteResult {
  const { result: _snapshot, ...routing } = execute
  void _snapshot
  return {
    ...routing,
    ok: false,
    error: {
      code: 'response-too-large',
      message: 'External Chrome screenshot alone exceeds the negotiated response envelope.',
      retryable: false,
      details: {
        limitation: 'screenshot-only-envelope-overflow',
        screenshotBytes,
        maximumBytes,
      },
    },
  } as ExternalChromeExecuteResult
}

/**
 * Fit one snapshot response before NativeRpcClient serializes the JSON-RPC envelope.
 * The screenshot is never compacted. Every candidate is measured as the complete
 * JSON-RPC response with exact UTF-8 bytes, and the safety margin remains outside
 * the candidate budget for relay evolution and authenticated framing.
 */
export function compactSnapshotForJsonRpc(
  result: unknown,
  id: string,
  maxMessageBytes: number,
): unknown {
  const execute = snapshotResponse(result)
  if (execute === null) return result
  const snapshot = execute.result as BrowserAutomationResultByOperation['snapshot']
  const budget = Math.max(1, maxMessageBytes - EXTERNAL_CHROME_RESPONSE_SAFETY_MARGIN_BYTES)
  if (jsonRpcResponseBytes(id, result) <= budget) return result

  const omitted: OmittedCounts = {}
  let candidate: BrowserSnapshotResult = { ...snapshot }
  const finalized = (value: BrowserSnapshotResult, counts: OmittedCounts): BrowserSnapshotResult => compactedResult(value, counts)
  const fits = (value: BrowserSnapshotResult, counts: OmittedCounts = omitted): boolean =>
    jsonRpcResponseBytes(id, { ...execute, result: finalized(value, counts) }) <= budget
  const finish = (): unknown => ({ ...execute, result: finalized(candidate, omitted) })

  if (candidate.consoleEntries.length > 0) {
    omitted.consoleEntries = candidate.consoleEntries.length
    candidate = { ...candidate, consoleEntries: [] }
  }
  if (candidate.networkEntries.length > 0) {
    omitted.networkEntries = candidate.networkEntries.length
    candidate = { ...candidate, networkEntries: [] }
  }
  if (candidate.actionTimeline.length > 0) {
    omitted.actionTimelineEntries = candidate.actionTimeline.length
    candidate = { ...candidate, actionTimeline: [] }
  }
  if (fits(candidate)) return finish()

  const accessibilityRoot = record(candidate.accessibility)
  if (accessibilityRoot && Array.isArray(accessibilityRoot.frames)) {
    const frames = accessibilityRoot.frames.map((frame) => {
      const frameRecord = record(frame)
      const nodes = frameRecord && Array.isArray(frameRecord.nodes) ? frameRecord.nodes : []
      const retained = nodes.slice(0, MAX_ACCESSIBILITY_NODES_AFTER_COMPACTION)
      const dropped = nodes.length - retained.length
      if (dropped > 0) omitted.accessibilityNodes = (omitted.accessibilityNodes ?? 0) + dropped
      return frameRecord === null ? frame : { ...frameRecord, nodes: retained }
    })
    candidate = { ...candidate, accessibility: { ...accessibilityRoot, frames } }
  }
  if (fits(candidate)) return finish()

  // Keep the beginning of visible text deterministic while making room for
  // interactive elements, which are the primary action semantics.
  const originalVisibleText = candidate.visibleText
  if (originalVisibleText.length > MAX_VISIBLE_TEXT_AFTER_COMPACTION) {
    omitted.visibleTextCharacters = originalVisibleText.length - MAX_VISIBLE_TEXT_AFTER_COMPACTION
    candidate = { ...candidate, visibleText: originalVisibleText.slice(0, MAX_VISIBLE_TEXT_AFTER_COMPACTION) }
  }
  if (fits(candidate)) return finish()

  const interactive = candidate.interactiveElements
  let low = 0
  let high = interactive.length
  let best: BrowserSnapshotResult | null = null
  let bestOmitted: OmittedCounts | null = null
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const next = { ...candidate, interactiveElements: interactive.slice(0, count) }
    const nextOmitted: OmittedCounts = {
      ...omitted,
      ...(count < interactive.length ? { interactiveElements: interactive.length - count } : {}),
    }
    if (fits(next, nextOmitted)) {
      best = next
      bestOmitted = nextOmitted
      low = count + 1
    } else high = count - 1
  }
  if (best !== null && bestOmitted !== null) {
    Object.assign(omitted, bestOmitted)
    candidate = best
    return finish()
  }

  // If no interactive prefix can fit, remove optional accessibility data and
  // retry once. A screenshot that still cannot fit gets a typed failure rather
  // than being silently dropped or exceeding the native protocol bound.
  const axNodes = countAccessibilityNodes(candidate.accessibility)
  if (axNodes > 0) omitted.accessibilityNodes = (omitted.accessibilityNodes ?? 0) + axNodes
  candidate = { ...candidate, accessibility: { frames: [] }, interactiveElements: [], visibleText: '' }
  const fallbackOmitted: OmittedCounts = {
    ...omitted,
    ...(interactive.length > 0 ? { interactiveElements: interactive.length } : {}),
    ...(originalVisibleText.length > 0 ? { visibleTextCharacters: originalVisibleText.length } : {}),
  }
  if (fits(candidate, fallbackOmitted)) {
    Object.assign(omitted, fallbackOmitted)
    return finish()
  }

  const screenshot = record(candidate.screenshot)
  const screenshotData = typeof screenshot?.data === 'string' ? screenshot.data : ''
  return failureForScreenshotOverflow(execute, utf8Bytes(screenshotData), budget)
}
