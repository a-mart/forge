import type {
  BrowserAutomationRequest,
  BrowserAutomationResultByOperation,
  BrowserTabSnapshot,
} from '@forge/protocol'
import type {
  ExternalChromeTransport,
  ExternalChromeTransportResult,
} from '../../external-chrome-target-adapter.js'

export class FakeExternalChromeTransport implements ExternalChromeTransport {
  readonly requests: BrowserAutomationRequest[] = []
  constructor(readonly maxResponseBytes = 1_000_000) {}

  async execute(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult> {
    this.requests.push(structuredClone(request))
    const tab = fakeExternalTab(request)
    const results: BrowserAutomationResultByOperation = {
      status: {
        available: true,
        host: { hostKind: 'external-chrome', connected: true, hostId: request.hostId, hostGeneration: request.hostGeneration, focused: false, capabilities: null, connectedAt: new Date(0).toISOString() },
        panelVisible: false, panelRevealRequested: false, physicalTabVisible: false, selectedTab: request.tabId ? tab : null,
      },
      open: { tab, created: request.tabId === null, panelRevealRequested: false },
      navigate: { tab: { ...tab, url: 'https://navigated.example/' }, readiness: 'load' },
      resize: { tabId: tab.tabId, setting: { mode: 'fill' }, viewport: tab.renderedViewport! },
      snapshot: {
        tabId: tab.tabId, url: tab.url, title: tab.title, loading: false, viewportSetting: tab.viewportSetting,
        viewport: tab.renderedViewport!, visibleText: 'External Chrome fake', interactiveElements: [], accessibility: { nodes: [] },
        consoleEntries: [], networkEntries: [], actionTimeline: [],
        screenshot: { mimeType: 'image/png', data: 'ZmFrZQ==', width: 800, height: 600 },
      },
      click: { tabId: tab.tabId, point: { x: 10, y: 20 } },
      type: { tabId: tab.tabId, characters: 4, cleared: false },
      press: { tabId: tab.tabId, key: 'Enter', modifiers: [] },
      scroll: { tabId: tab.tabId, deltaX: 0, deltaY: 100, scrollX: 0, scrollY: 100 },
      evaluate: { tabId: tab.tabId, value: 2, serializedBytes: 1 },
      waitFor: { tabId: tab.tabId, matched: true, elapsedMs: 1 },
      recordingStart: { recordingId: 'unsupported', tabId: tab.tabId, recording: true, startedAt: new Date(0).toISOString(), mimeType: 'video/webm', width: 800, height: 600 },
      recordingStop: { recordingId: 'unsupported', tabId: tab.tabId, path: '/unsupported', mimeType: 'video/webm', extension: 'webm', sizeBytes: 1, width: 800, height: 600, createdAt: new Date(0).toISOString() },
    }
    return { ok: true, result: results[request.operation], updatedTab: tab, elapsedMs: 1 }
  }
}

function fakeExternalTab(request: BrowserAutomationRequest): BrowserTabSnapshot {
  const now = new Date(0).toISOString()
  return {
    hostKind: 'external-chrome',
    tabId: request.tabId ?? 'external-tab-1', sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    url: 'https://example.test/', title: 'External Chrome fake', lifecycle: 'ready', loading: false, live: true,
    canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null,
    viewportSetting: { mode: 'fill' }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    physicalVisible: false, error: null, createdAt: now, updatedAt: now,
  }
}
