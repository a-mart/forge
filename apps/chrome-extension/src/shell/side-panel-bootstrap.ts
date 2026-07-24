import { loadVerifiedPayloadSelector } from './selector.js'

interface SidePanelChrome {
  runtime: { getURL(path: string): string }
}

const chromeApi = (globalThis as unknown as { chrome: SidePanelChrome }).chrome

async function boot(): Promise<void> {
  const selector = await loadVerifiedPayloadSelector((path) => chromeApi.runtime.getURL(path), 'side-panel.js')
  const moduleUrl = chromeApi.runtime.getURL(`payloads/${selector.payloadDirectory}/side-panel.js`)
  const module = await import(moduleUrl) as { activateSidePanel?: () => void }
  if (typeof module.activateSidePanel !== 'function') throw new Error('selected payload has no side-panel activation export')
  module.activateSidePanel()
}

void boot().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>('[data-forge-status]')
  if (status !== null) status.textContent = `Payload unavailable: ${(error instanceof Error ? error.message : 'unknown error').slice(0, 160)}`
})
