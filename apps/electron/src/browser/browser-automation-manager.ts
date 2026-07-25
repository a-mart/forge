import {
  DEFAULT_BROWSER_HOST_KIND,
  type BrowserAutomationFailure,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from '@forge/protocol'
import type { BrowserTargetAdapter } from './browser-target-adapter.js'
import {
  ManagedElectronTargetAdapter,
  type ManagedElectronTargetAdapterOptions,
} from './managed-electron-target-adapter.js'

export * from './managed-electron-target-adapter.js'

export interface BrowserAutomationManagerOptions extends ManagedElectronTargetAdapterOptions {
  externalChromeAdapter?: BrowserTargetAdapter
}

/** Routes protocol-native requests to host adapters while retaining the Managed Browser control API. */
export class BrowserAutomationManager extends ManagedElectronTargetAdapter {
  private readonly externalChromeAdapter?: BrowserTargetAdapter

  constructor(options: BrowserAutomationManagerOptions) {
    super(options)
    this.externalChromeAdapter = options.externalChromeAdapter
  }

  override async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    const hostKind = request.hostKind ?? DEFAULT_BROWSER_HOST_KIND
    if (hostKind === 'managed-electron') return super.execute({ ...request, hostKind })
    if (this.externalChromeAdapter?.hostKind === hostKind) return this.externalChromeAdapter.execute({ ...request, hostKind })
    return unavailableResponse(request, {
      code: 'unavailable-host',
      message: 'No External Chrome adapter is connected.',
      retryable: true,
    })
  }
}

function unavailableResponse(request: BrowserAutomationRequest, error: BrowserAutomationFailure): BrowserAutomationResponse {
  return {
    requestId: request.requestId,
    hostKind: request.hostKind ?? DEFAULT_BROWSER_HOST_KIND,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
    operation: request.operation,
    ok: false,
    error,
    elapsedMs: 0,
  }
}
