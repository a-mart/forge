import type {
  BrowserAutomationFailure,
  BrowserAutomationOperation,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostLifecycleReason,
  BrowserTargetAffinity,
  BrowserEligibleTab,
} from '@forge/protocol'

export const AUTOMATIC_BROWSER_FALLBACK_REASONS = [
  'integration-unavailable',
  'runtime-not-ready',
  'operation-unsupported',
  'no-eligible-target',
  'restricted-target',
  'foreign-debugger',
  'authority-conflict',
  'transport-disconnected',
] as const

export type AutomaticBrowserFallbackReason = (typeof AUTOMATIC_BROWSER_FALLBACK_REASONS)[number]
export type BrowserMutationState = 'not-started' | 'possible' | 'confirmed'
export type BrowserFailurePhase = 'discovery' | 'acquisition' | 'execution' | 'cleanup'

export interface BrowserTargetCapabilities {
  readonly supportedOperations: readonly BrowserAutomationOperation[]
  readonly physicalViewport: boolean
  readonly recording: boolean
  readonly reveal: boolean
}

/** Typed Desktop-private metadata used to decide whether a request may move to another browser identity. */
export interface BrowserTargetFailureMetadata {
  readonly phase: BrowserFailurePhase
  readonly mutationState: BrowserMutationState
  readonly fallbackReason?: AutomaticBrowserFallbackReason
  /** Exact extension proof that this failed operation must never be replayed or fall back. */
  readonly noReplay?: boolean
  /** Exact extension proof that the same physical debugger is safely attached-idle. */
  readonly preserveAuthority?: boolean
  /** A fresh snapshot must succeed before another potentially mutating operation. */
  readonly requiresReobserve?: boolean
}

export interface BrowserTargetExecution {
  readonly response: BrowserAutomationResponse
  /** Fail closed when an adapter cannot prove that mutation did not start. */
  readonly failure?: BrowserTargetFailureMetadata
}

export interface BrowserTargetSession {
  readonly sessionAgentId: string
  readonly profileId: string
}

/** Host-specific execution boundary. Adapters operate on protocol DTOs, not WebContents-shaped facades. */
export interface BrowserTargetAdapter {
  readonly targetAffinity: BrowserTargetAffinity
  readonly capabilities: BrowserTargetCapabilities
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse>
  endTurn?(session: BrowserTargetSession, turnId: string): Promise<void>
  releaseSession?(session: BrowserTargetSession, reason: BrowserHostLifecycleReason): Promise<void>
  destroy?(): Promise<void>
}

export interface ExternalBrowserTargetAuthority {
  readonly ownerEpoch: number
  readonly tabId: string
}

export interface ExternalBrowserAcquireInput extends BrowserTargetSession {
  readonly operation: BrowserAutomationOperation
  readonly preferredTabId: string | null
  readonly reuseExisting: boolean
  readonly createIfNeeded: boolean
  /** Absolute request deadline, when acquisition is part of a browser call. */
  readonly deadlineAt?: number
  readonly ownerEpoch: number
}

export type ExternalBrowserAcquireResult =
  | {
      readonly ok: true
      readonly authority: ExternalBrowserTargetAuthority
  }
  | {
      readonly ok: false
      readonly error: BrowserAutomationFailure
      readonly metadata: BrowserTargetFailureMetadata
    }

export interface ExternalBrowserExecuteInput {
  readonly authority: ExternalBrowserTargetAuthority
  readonly request: BrowserAutomationRequest
}

export interface ExternalBrowserRevealResult {
  readonly revealed: true
  readonly tabId: string
}

export interface ExternalBrowserInventory {
  readonly tabs: readonly BrowserEligibleTab[]
  readonly truncated: boolean
}

/** Narrow automatic-policy seam for authenticated profile-wide Chrome access. */
export interface AutomaticExternalBrowserAdapter extends BrowserTargetAdapter {
  listEligibleTabs(session: BrowserTargetSession, deadlineAt?: number): Promise<ExternalBrowserInventory>
  readonly targetAffinity: 'external-chrome'
  acquireTarget(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult>
  executeWithAuthority(input: ExternalBrowserExecuteInput): Promise<BrowserTargetExecution>
  releaseAuthority(
    session: BrowserTargetSession,
    authority: ExternalBrowserTargetAuthority,
    reason: 'idle' | 'operation-failed' | 'turn-ended' | 'take-control' | BrowserHostLifecycleReason,
    deadlineAt?: number,
  ): Promise<void>
  /** Release an exact durable tab checkpoint when Desktop host memory did not survive restart. */
  releaseTargetAuthority(session: BrowserTargetSession, tabId: string, reason: 'take-control'): Promise<boolean>
  revealTarget(session: BrowserTargetSession, tabId: string): Promise<ExternalBrowserRevealResult>
}

export function isAutomaticExternalBrowserAdapter(
  adapter: BrowserTargetAdapter | undefined,
): adapter is AutomaticExternalBrowserAdapter {
  if (!adapter || adapter.targetAffinity !== 'external-chrome') return false
  const candidate = adapter as Partial<AutomaticExternalBrowserAdapter>
  return typeof candidate.listEligibleTabs === 'function'
    && typeof candidate.acquireTarget === 'function'
    && typeof candidate.executeWithAuthority === 'function'
    && typeof candidate.releaseAuthority === 'function'
    && typeof candidate.revealTarget === 'function'
}
