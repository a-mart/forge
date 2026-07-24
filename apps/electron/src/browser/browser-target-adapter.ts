import type {
  BrowserAutomationOperation,
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostKind,
} from '@forge/protocol'

/** Host-specific execution boundary. Adapters operate on protocol DTOs, not WebContents-shaped facades. */
export interface BrowserTargetAdapter {
  readonly hostKind: BrowserHostKind
  readonly supportedOperations: readonly BrowserAutomationOperation[]
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse>
}
