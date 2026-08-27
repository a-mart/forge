import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { BrowserAutomationManager } from './browser-automation-manager.js'
import { BrowserSessionRegistry } from './browser-session.js'
import { ManagedBrowserViewHost } from './managed-browser-view-host.js'
import type { BrowserAutomationRequest, BrowserSessionSnapshot, BrowserTabSnapshot } from '@forge/protocol'

const root = process.env.FORGE_BROWSER_POPOUT_FIXTURE_ROOT
if (!root) throw new Error('FORGE_BROWSER_POPOUT_FIXTURE_ROOT is required')
mkdirSync(root, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.commandLine.appendSwitch('disable-background-timer-throttling')

const html = `<!doctype html><html><head><title>Product popout</title></head><body><button id="inc">Increment</button><output id="value">0</output><script>window.__identity='fixture';inc.onclick=()=>value.textContent=String(Number(value.textContent)+1)</script></body></html>`
const listen = async (server: http.Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind'); return address.port
}

void app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html) })
  const port = await listen(server)
  const main = new BrowserWindow({ show: false, width: 900, height: 700 })
  const popout = new BrowserWindow({ show: false, width: 900, height: 700 })
  const manager = new BrowserAutomationManager({ approvedDataRoot: root, sendToRenderer: () => undefined })
  const host = new ManagedBrowserViewHost({ manager, sessions: new BrowserSessionRegistry(), guestPreloadPath: path.join(__dirname, 'guest-preload.js') })
  const now = new Date().toISOString()
  const url = `http://127.0.0.1:${port}/fixture`
  const tab: BrowserTabSnapshot = { targetAffinity: 'managed-electron', tabId: 'product-tab', sessionAgentId: 'product-session', profileId: 'product-profile', url, title: 'Product', lifecycle: 'restoring', loading: false, live: false, canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null, recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null, createdAt: now, updatedAt: now }
  const session: BrowserSessionSnapshot = { schemaVersion: 2, sessionAgentId: 'product-session', profileId: 'product-profile', hostingState: 'hosted', tabs: [tab], activeTabId: tab.tabId, defaultTabId: tab.tabId, panelVisible: true, recentActions: [], revision: 1, createdAt: now, updatedAt: now }
  const request = <T extends BrowserAutomationRequest['operation']>(operation: T, input: Extract<BrowserAutomationRequest, { operation: T }>['input']): BrowserAutomationRequest => ({ requestId: `product-${operation}-${Date.now()}`, sessionAgentId: tab.sessionAgentId, profileId: tab.profileId, tabId: tab.tabId, hostId: 'product-host', hostGeneration: 5, deadlineAt: new Date(Date.now() + 10_000).toISOString(), artifactDirectory: null, operation, input } as BrowserAutomationRequest)
  let passed = false
  let report: Record<string, unknown> = {}
  try {
    await host.reconcile({ controllerInstanceId: 'product-controller', hostGeneration: 5, updateSequence: 1, workspaceEpoch: 4, sessions: [session] })
    const metrics = { workspaceEpoch: 4, rect: { x: 0, y: 0, width: 800, height: 600 }, innerWidth: 900, innerHeight: 700 }
    host.setPresentationTarget('docked', main, metrics); host.setPresentationTarget('popout', popout, metrics)
    await host.present({ tabId: tab.tabId, visible: true, viewportSetting: { mode: 'fill' }, renderedViewport: { width: 800, height: 600, deviceScaleFactor: 1 }, hostGeneration: 5, sessionRevision: 1, sequence: 1, workspaceEpoch: 4 })
    const waited = await manager.execute(request('waitFor', { text: 'Increment', timeoutMs: 5_000 }))
    if (!waited.ok) throw new Error(waited.error.message)
    const identity = host.getTabWebContentsId(tab.tabId)
    const setup = await manager.execute(request('evaluate', { expression: `localStorage.setItem('product','kept');history.pushState({kept:true},'', '/kept');window.__runtime={count:1};({url:location.href})`, awaitPromise: true, returnByValue: true }))
    if (!setup.ok) throw new Error(setup.error.message)
    const owners: string[] = []
    for (const owner of ['popout', 'docked', 'popout', 'docked'] as const) {
      const moved = await host.transferOwner(owner, 4)
      if (!moved || host.getTabWebContentsId(tab.tabId) !== identity) throw new Error(`${owner} changed native identity`)
      const continuity = await manager.execute(request('evaluate', { expression: `({identity:window.__identity,count:window.__runtime.count,storage:localStorage.getItem('product'),url:location.href})`, awaitPromise: true, returnByValue: true }))
      const value = continuity.ok && continuity.operation === 'evaluate' ? continuity.result.value as Record<string, unknown> : null
      if (!continuity.ok || value?.identity !== 'fixture' || value.count !== 1 || value.storage !== 'kept' || value.url !== `http://127.0.0.1:${port}/kept`) throw new Error(`${owner} lost page continuity: ${JSON.stringify(value)}`)
      owners.push(owner)
    }
    const unhosted = { ...session, hostingState: 'unhosted' as const, revision: 2 }
    await host.reconcile({ controllerInstanceId: 'product-controller', hostGeneration: 5, updateSequence: 2, workspaceEpoch: 4, sessions: [unhosted] })
    passed = host.tabCount === 0 && manager.runtimeCount === 0
    report = { passed, platform: process.platform, identity, owners, oneRuntime: true, canonicalCloseWon: passed }
  } catch (error) {
    report = { passed: false, error: error instanceof Error ? error.stack : String(error) }
  } finally {
    await host.destroy(); await host.destroy()
    if (!main.isDestroyed()) main.destroy(); if (!popout.isDestroyed()) popout.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  process.stdout.write(`FORGE_BROWSER_POPOUT_PRODUCT_RESULT=${JSON.stringify(report)}\n`)
  app.exit(passed ? 0 : 1)
}).catch((error) => { process.stderr.write(String(error)); app.exit(1) })
