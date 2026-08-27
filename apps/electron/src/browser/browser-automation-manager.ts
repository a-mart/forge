import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostLifecycleRequest,
  BrowserHostLifecycleResponse,
  BrowserSessionSnapshot,
  BrowserTabSnapshot,
} from '@forge/protocol'
import {
  AutomaticBrowserHost,
  type AutomaticBrowserHostOptions,
  type AutomaticBrowserRevealResult,
} from './automatic-browser-host.js'
import type { BrowserTargetAdapter, BrowserTargetSession } from './browser-target-adapter.js'
import {
  ManagedElectronTargetAdapter,
  type BrowserTabRegistration,
  type BrowserWebContentsLike,
  type ManagedElectronTargetAdapterOptions,
  type PreparedRecording,
} from './managed-electron-target-adapter.js'
import type { BrowserPresentationAcknowledgement, BrowserPresentationRequest } from './browser-bridge-contract.js'

export * from './automatic-browser-host.js'
export * from './browser-target-adapter.js'
export * from './managed-electron-target-adapter.js'

export interface BrowserAutomationManagerOptions extends ManagedElectronTargetAdapterOptions {
  externalChromeAdapter?: BrowserTargetAdapter
  ensureManagedTarget?: AutomaticBrowserHostOptions['ensureManagedTarget']
  authorityBurst?: AutomaticBrowserHostOptions['authorityBurst']
}

/** Composition facade retaining the complete Managed Browser control API behind one automatic host. */
export class BrowserAutomationManager {
  private readonly managed: ManagedElectronTargetAdapter
  private readonly automaticHost: AutomaticBrowserHost

  constructor(options: BrowserAutomationManagerOptions) {
    this.managed = new ManagedElectronTargetAdapter(options)
    this.automaticHost = new AutomaticBrowserHost({
      managedAdapter: this.managed,
      externalAdapter: options.externalChromeAdapter,
      ensureManagedTarget: options.ensureManagedTarget,
      authorityBurst: options.authorityBurst,
      now: options.now,
    })
  }

  get capabilities(): AutomaticBrowserHost['capabilities'] { return this.automaticHost.capabilities }
  get runtimeCount(): number { return this.managed.runtimeCount }

  synchronizeSessions(snapshots: readonly BrowserSessionSnapshot[]): void {
    this.automaticHost.synchronizeSessions(snapshots)
  }

  registerTabWebContents(registration: BrowserTabRegistration, webContents: BrowserWebContentsLike): BrowserTabSnapshot {
    const tab = this.managed.registerTabWebContents(registration, webContents)
    this.automaticHost.adoptTarget(tab)
    return tab
  }

  hasTab(tabId: string): boolean { return this.managed.hasTab(tabId) }
  captureScreenshot(tabId: string): Promise<string> { return this.managed.captureScreenshot(tabId) }
  markGuestCrashed(tabId: string, reason?: string): void { this.managed.markGuestCrashed(tabId, reason) }
  setTabPresentation(request: BrowserPresentationRequest): BrowserPresentationAcknowledgement {
    return this.managed.setTabPresentation(request)
  }
  humanNavigate(tabId: string, rawUrl: string): Promise<BrowserTabSnapshot> {
    return this.managed.humanNavigate(tabId, rawUrl)
  }
  humanHistory(tabId: string, direction: 'back' | 'forward'): BrowserTabSnapshot {
    return this.managed.humanHistory(tabId, direction)
  }
  humanReload(tabId: string, hard: boolean): BrowserTabSnapshot { return this.managed.humanReload(tabId, hard) }
  humanSetZoom(tabId: string, factor: number): BrowserTabSnapshot { return this.managed.humanSetZoom(tabId, factor) }
  unregisterTabWebContents(tabId: string, webContentsId?: number): void {
    this.managed.unregisterTabWebContents(tabId, webContentsId)
  }
  execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    return this.automaticHost.perform(request)
  }

  handleLifecycle(request: BrowserHostLifecycleRequest): Promise<BrowserHostLifecycleResponse> {
    return this.automaticHost.handleLifecycle(request)
  }

  endTurn(session: BrowserTargetSession, turnId: string): Promise<void> {
    return this.automaticHost.endTurn(session, turnId)
  }

  releaseSession(
    session: BrowserTargetSession,
    reason: Extract<BrowserHostLifecycleRequest, { kind: 'release-session' }>['reason'],
  ): Promise<void> {
    return this.automaticHost.releaseSession(session, reason)
  }

  takeControl(session: BrowserTargetSession, tabId: string): Promise<{ released: boolean; tabId: string }> {
    return this.automaticHost.takeControl(session, tabId)
  }

  revealTarget(session: BrowserTargetSession, tabId: string): Promise<AutomaticBrowserRevealResult> {
    return this.automaticHost.revealTarget(session, tabId)
  }

  prepareRecording(request: BrowserAutomationRequest & { operation: 'recordingStart' }): Promise<PreparedRecording> {
    return this.managed.prepareRecording(request)
  }
  setRecordingMimeType(request: BrowserAutomationRequest & { operation: 'recordingStart' }, mimeType: string): void {
    this.managed.setRecordingMimeType(request, mimeType)
  }
  stopRecordingCapture(request: BrowserAutomationRequest & { operation: 'recordingStop' }): Promise<PreparedRecording> {
    return this.managed.stopRecordingCapture(request)
  }
  saveRecording(
    request: BrowserAutomationRequest & { operation: 'recordingStop' },
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<BrowserAutomationResponse> {
    return this.managed.saveRecording(request, mimeType, bytes)
  }
  cancelRecording(recordingId?: string): void { this.managed.cancelRecording(recordingId) }

  destroy(): Promise<void> { return this.automaticHost.destroy() }
}
