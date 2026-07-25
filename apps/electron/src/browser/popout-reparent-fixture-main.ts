import { app, BrowserWindow, WebContentsView, type BrowserWindowConstructorOptions, type WebPreferences } from 'electron'
import type { BrowserAutomationRequest, BrowserTabSnapshot } from '@forge/protocol'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { BrowserAutomationManager, BROWSER_RECORDING_FRAME_CHANNEL } from './browser-automation-manager.js'
import { BrowserSessionRegistry } from './browser-session.js'
import { secureBrowserWebPreferences } from './browser-webview-security.js'

const root = process.env.FORGE_BROWSER_POPOUT_FIXTURE_ROOT
if (!root) throw new Error('FORGE_BROWSER_POPOUT_FIXTURE_ROOT is required')
mkdirSync(root, { recursive: true })
app.setPath('userData', path.join(root, 'electron-user-data'))
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.on('window-all-closed', () => { /* fixture owns explicit teardown and exit */ })

const fixtureHtml = `<!doctype html><html><head><title>WCV continuity fixture</title><style>body{font:16px sans-serif;margin:0;height:1200px;background:#eef}#pulse{width:60px;height:60px;background:#36c}</style></head><body>
<div id="pulse"></div><output id="dom-state">initial</output><input id="human-input" autofocus>
<script>
window.__fixtureNavigationLoads=(window.__fixtureNavigationLoads||0)+1;
window.__startFrames=()=>{let on=false;window.__frameTimer=setInterval(()=>{on=!on;document.querySelector('#pulse').style.transform=on?'translateX(80px)':'translateX(0)'},40)};
</script></body></html>`

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('Fixture server did not bind TCP'))
      else resolve(address.port)
    })
  })
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function waitUntil(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

interface PageState {
  sentinel: string
  dom: string
  url: string
  historyLength: number
  localStorage: string | null
  sessionStorage: string | null
  indexedDb: string
  navigationLoads: number
}

type Owner = 'main' | 'popout'

process.stderr.write('popout-fixture: bootstrap\n')
void app.whenReady().then(async () => {
  process.stderr.write('popout-fixture: ready\n')
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(fixtureHtml)
  })
  const port = await listen(server)
  const fixtureUrl = `http://127.0.0.1:${port}/fixture`
  const guestPreloadPath = path.join(__dirname, 'guest-preload.js')
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false,
    width: 1_000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  }
  const mainWindow = new BrowserWindow(windowOptions)
  let popoutWindow: BrowserWindow | null = null
  const sessions = new BrowserSessionRegistry()
  const managedSession = sessions.getSession('popout-fixture-profile')
  const expectedPartition = sessions.getPartition('popout-fixture-profile')
  const preferences: WebPreferences = { session: managedSession }
  secureBrowserWebPreferences(preferences, guestPreloadPath)
  const view = new WebContentsView({ webPreferences: preferences })
  const guest = view.webContents
  const guestId = guest.id
  const managerIdentity = randomUUID()
  const hostGeneration = 41
  let currentOwner: Owner = 'main'
  let registerCount = 0
  let unregisterCount = 0
  let navigationEvents = 0
  let debuggerDetachCount = 0
  let guestDestroyedCount = 0
  let titleBarRecoveries = 0
  let closeRaceRecoveries = 0
  const stateEvents: BrowserTabSnapshot[] = []
  const frames: Array<{ owner: Owner; bytes: number }> = []
  guest.on('did-navigate', () => { navigationEvents += 1 })
  guest.on('did-navigate-in-page', () => { navigationEvents += 1 })
  guest.on('destroyed', () => { guestDestroyedCount += 1 })
  guest.debugger.on('detach', () => { debuggerDetachCount += 1 })

  const manager = new BrowserAutomationManager({
    approvedDataRoot: root,
    hostWebContentsId: mainWindow.webContents.id,
    sendToRenderer: (channel, payload) => {
      if (channel === BROWSER_RECORDING_FRAME_CHANNEL) {
        const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined
        if (typeof data === 'string') frames.push({ owner: currentOwner, bytes: Buffer.byteLength(data, 'base64') })
      } else if (payload && typeof payload === 'object' && 'tabId' in payload) {
        stateEvents.push(payload as BrowserTabSnapshot)
      }
    },
  })

  const bounds = { x: 20, y: 30, width: 820, height: 620 }
  const validBounds = (candidate: Electron.Rectangle): boolean => [candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)
    && candidate.width > 0 && candidate.height > 0
  const ownerWindow = (owner: Owner): BrowserWindow => {
    if (owner === 'main') return mainWindow
    if (!popoutWindow || popoutWindow.isDestroyed()) throw new Error('Pop-out window is unavailable')
    return popoutWindow
  }
  const transfer = (owner: Owner, candidate: Electron.Rectangle): boolean => {
    if (!validBounds(candidate)) return false
    const target = ownerWindow(owner)
    if (target.isDestroyed()) return false
    const source = ownerWindow(currentOwner)
    if (source !== target) {
      source.contentView.removeChildView(view)
      target.contentView.addChildView(view)
    }
    view.setBounds(candidate)
    view.setVisible(true)
    currentOwner = owner
    return true
  }
  const createPopout = (): BrowserWindow => {
    if (popoutWindow && !popoutWindow.isDestroyed()) return popoutWindow
    const candidate = new BrowserWindow(windowOptions)
    popoutWindow = candidate
    void candidate.loadURL('data:text/html,<title>Managed Browser pop-out host</title>')
    candidate.show()
    let recovering = false
    candidate.on('close', (event) => {
      if (recovering) return
      event.preventDefault()
      recovering = true
      if (currentOwner === 'popout') {
        if (!transfer('main', bounds)) throw new Error('Title-bar close failed to recover the view')
        titleBarRecoveries += 1
      }
      setImmediate(() => { if (!candidate.isDestroyed()) candidate.destroy() })
    })
    candidate.on('closed', () => { if (popoutWindow === candidate) popoutWindow = null })
    return candidate
  }

  const now = new Date().toISOString()
  const tab: BrowserTabSnapshot = {
    tabId: 'popout-fixture-tab', sessionAgentId: 'popout-fixture-session', profileId: 'popout-fixture-profile',
    url: fixtureUrl, title: 'WCV continuity fixture', lifecycle: 'loading', loading: true, live: false,
    canGoBack: false, canGoForward: false, zoomFactor: 1, controller: 'none', agentCursor: null,
    recording: null, viewportSetting: { mode: 'fill' }, renderedViewport: null, error: null,
    createdAt: now, updatedAt: now,
  }
  let requestSequence = 0
  const request = (operation: BrowserAutomationRequest['operation'], input: Record<string, unknown>, timeoutMs = 15_000): BrowserAutomationRequest => ({
    requestId: `popout-fixture-${++requestSequence}`,
    hostKind: 'managed-electron',
    sessionAgentId: tab.sessionAgentId,
    profileId: tab.profileId,
    tabId: tab.tabId,
    hostId: 'stable-popout-fixture-host',
    hostGeneration,
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    artifactDirectory: null,
    operation,
    input,
  } as BrowserAutomationRequest)

  const cdpPageState = async (): Promise<PageState> => {
    const response = await guest.debugger.sendCommand('Runtime.evaluate', {
      expression: `new Promise(async resolve=>{const dbValue=await new Promise((ok,fail)=>{const open=indexedDB.open('continuity-db',1);open.onupgradeneeded=()=>open.result.createObjectStore('state');open.onerror=()=>fail(open.error);open.onsuccess=()=>{const get=open.result.transaction('state').objectStore('state').get('value');get.onsuccess=()=>ok(get.result);get.onerror=()=>fail(get.error)}});resolve({sentinel:window.__popoutSentinel,dom:document.querySelector('#dom-state').textContent,url:location.href,historyLength:history.length,localStorage:localStorage.getItem('continuity'),sessionStorage:sessionStorage.getItem('continuity'),indexedDb:dbValue,navigationLoads:window.__fixtureNavigationLoads})})`,
      awaitPromise: true,
      returnByValue: true,
    }) as { result?: { value?: PageState } }
    if (!response.result?.value) throw new Error('CDP page-state evaluation returned no value')
    return response.result.value
  }

  let report: Record<string, unknown> = { passed: false }
  try {
    process.stderr.write('popout-fixture: loading guest\n')
    await mainWindow.loadURL('data:text/html,<title>Forge main fixture host</title>')
    mainWindow.contentView.addChildView(view)
    view.setBounds(bounds)
    view.setVisible(true)
    mainWindow.show()
    await guest.loadURL(fixtureUrl)
    await guest.executeJavaScript(`(() => {
      window.__popoutSentinel=${JSON.stringify(randomUUID())};
      document.querySelector('#dom-state').textContent='mutated-before-transfer';
      localStorage.setItem('continuity','local-ok');sessionStorage.setItem('continuity','session-ok');
      document.cookie='continuity=cookie-ok; SameSite=Lax';
      history.pushState({step:1},'', '/fixture/step-one');history.pushState({step:2},'', '/fixture/step-two?kept=yes');
      return new Promise((resolve,reject)=>{const open=indexedDB.open('continuity-db',1);open.onupgradeneeded=()=>open.result.createObjectStore('state');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const tx=open.result.transaction('state','readwrite');tx.objectStore('state').put('indexeddb-ok','value');tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(tx.error)}})
    })()`)
    registerCount += 1
    manager.registerWebview({ tab: { ...tab, url: guest.getURL(), lifecycle: 'ready', loading: false }, webContentsId: guestId, visible: false, created: false }, guest)
    const presentation = manager.setTabPresentation({
      tabId: tab.tabId, visible: true, viewportSetting: { mode: 'fill' },
      renderedViewport: { width: bounds.width, height: bounds.height, deviceScaleFactor: 1 },
      hostGeneration, sessionRevision: 1, sequence: 1, workspaceEpoch: 1,
    })
    await waitUntil('manager debugger attachment', () => guest.debugger.isAttached())
    const baseline = await cdpPageState()
    const baselineNavigationEvents = navigationEvents
    const cookiesBefore = await managedSession.cookies.get({ url: fixtureUrl, name: 'continuity' })

    const checkpoints: Array<{ label: string; owner: Owner; guestId: number; page: PageState; debuggerAttached: boolean; managerIdentity: string }> = []
    const checkpoint = async (label: string): Promise<void> => {
      if (guest.id !== guestId || guest.isDestroyed()) throw new Error(`${label}: guest identity was not preserved`)
      const page = await cdpPageState()
      if (JSON.stringify(page) !== JSON.stringify(baseline)) throw new Error(`${label}: page/history/storage state changed: ${JSON.stringify(page)}`)
      if (!guest.debugger.isAttached()) throw new Error(`${label}: debugger detached`)
      if (navigationEvents !== baselineNavigationEvents) throw new Error(`${label}: transfer caused navigation`)
      checkpoints.push({ label, owner: currentOwner, guestId: guest.id, page, debuggerAttached: true, managerIdentity })
    }
    await checkpoint('docked-initial')

    process.stderr.write('popout-fixture: baseline ready\n')
    const recordingStart = await manager.execute(request('recordingStart', {}))
    if (!recordingStart.ok) throw new Error(`recording start failed: ${JSON.stringify(recordingStart.error)}`)
    const recordingId = (recordingStart.result as { recordingId: string }).recordingId
    await guest.executeJavaScript('window.__startFrames()')
    const waitForNextFrame = (owner: Owner, after: number): Promise<void> => waitUntil(`${owner} screencast frame after transfer`, async () => {
      await guest.executeJavaScript(`document.body.style.backgroundColor='hsl('+((Date.now()/10)%360)+',60%,90%)'`)
      await guest.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true })
      return frames.slice(after).some((frame) => frame.owner === owner && frame.bytes > 0)
    })
    await waitForNextFrame('main', 0)

    createPopout()
    let frameMark = frames.length
    if (!transfer('popout', bounds)) throw new Error('first pop-out transfer failed')
    await waitForNextFrame('popout', frameMark)
    await checkpoint('cycle-1-popout')
    frameMark = frames.length
    if (!transfer('main', bounds)) throw new Error('first dock transfer failed')
    await waitForNextFrame('main', frameMark)
    await checkpoint('cycle-1-docked')

    const inFlight = manager.execute(request('evaluate', {
      expression: `new Promise(resolve=>setTimeout(()=>resolve({sentinel:window.__popoutSentinel,dom:document.querySelector('#dom-state').textContent,url:location.href}),450))`,
      awaitPromise: true,
      returnByValue: true,
    }))
    createPopout()
    if (!transfer('popout', bounds)) throw new Error('second pop-out transfer failed')
    await delay(80)
    if (!transfer('main', bounds)) throw new Error('second dock transfer failed')
    await delay(80)
    frameMark = frames.length
    if (!transfer('popout', bounds)) throw new Error('third pop-out transfer failed')
    const inFlightResult = await inFlight
    await waitForNextFrame('popout', frameMark)
    if (!inFlightResult.ok || ((inFlightResult.result as { value?: { sentinel?: string } }).value?.sentinel !== baseline.sentinel)) {
      throw new Error(`in-flight evaluate did not survive transfer: ${JSON.stringify(inFlightResult)}`)
    }
    await checkpoint('in-flight-multi-cycle-popout')
    if (!transfer('main', bounds)) throw new Error('third dock transfer failed')

    const ownerBeforeInvalid = currentOwner
    const zeroBoundsRejected = !transfer('main', { x: 0, y: 0, width: 0, height: 600 })
    const invalidBoundsRejected = !transfer('main', { x: Number.NaN, y: 0, width: 800, height: -1 })
    const invalidBoundsStable = currentOwner === ownerBeforeInvalid && guest.id === guestId && !guest.isDestroyed()
    await checkpoint('invalid-bounds-rejected')

    const humanWait = manager.execute(request('waitFor', { text: 'never-present-human-interrupt', timeoutMs: 4_000 }, 8_000))
    await delay(100)
    guest.focus()
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Z' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Z' })
    const humanResult = await humanWait
    const humanInputObserved = !humanResult.ok && humanResult.error.code === 'control-interrupted'
    if (!humanInputObserved) throw new Error(`guest preload human input was not observed: ${JSON.stringify(humanResult)}`)

    const titlePopout = createPopout()
    frameMark = frames.length
    if (!transfer('popout', bounds)) throw new Error('title-bar cycle transfer failed')
    await waitForNextFrame('popout', frameMark)
    await checkpoint('title-bar-before-close')
    frameMark = frames.length
    titlePopout.close()
    await waitUntil('title-bar close recovery', () => titlePopout.isDestroyed() && currentOwner === 'main')
    await waitForNextFrame('main', frameMark)
    await checkpoint('title-bar-close-recovered')

    const racePopout = createPopout()
    if (!transfer('popout', bounds)) throw new Error('close race transfer failed')
    frameMark = frames.length
    racePopout.close()
    racePopout.close()
    setImmediate(() => { if (!racePopout.isDestroyed()) racePopout.destroy() })
    await waitUntil('close/destroy race recovery', () => racePopout.isDestroyed() && currentOwner === 'main')
    await waitForNextFrame('main', frameMark)
    closeRaceRecoveries += 1
    await checkpoint('close-destroy-race-recovered')

    const stopped = await manager.stopRecordingCapture(request('recordingStop', { recordingId }) as BrowserAutomationRequest & { operation: 'recordingStop' })
    const frameOwners = [...new Set(frames.filter((frame) => frame.bytes > 0).map((frame) => frame.owner))]
    const cookiesAfter = await managedSession.cookies.get({ url: fixtureUrl, name: 'continuity' })
    const status = await manager.execute(request('status', {}))
    const continuity = {
      sameWebContentsId: checkpoints.every((item) => item.guestId === guestId),
      sameView: view.webContents === guest,
      sameManagerRuntime: checkpoints.every((item) => item.managerIdentity === managerIdentity),
      noNavigation: navigationEvents === baselineNavigationEvents,
      noRegisterOrUnregisterDuringTransfer: registerCount === 1 && unregisterCount === 0,
      noDebuggerDetach: debuggerDetachCount === 0 && guest.debugger.isAttached(),
      noGuestDestruction: guestDestroyedCount === 0 && !guest.isDestroyed(),
      stableHostGeneration: hostGeneration === 41 && inFlightResult.hostGeneration === hostGeneration && status.hostGeneration === hostGeneration,
      stateAndHistory: checkpoints.every((item) => JSON.stringify(item.page) === JSON.stringify(baseline)),
      managedPartitionStorage: guest.session === managedSession && expectedPartition.startsWith('persist:forge-browser-')
        && cookiesBefore[0]?.value === 'cookie-ok' && cookiesAfter[0]?.value === 'cookie-ok',
      debuggerCdpEvaluate: checkpoints.length >= 8,
      inFlightCommand: inFlightResult.ok,
      humanInputObserved,
      recordingFrames: frames.length > 0 && frameOwners.includes('main') && frameOwners.includes('popout'),
      recordingIdentity: stopped.recordingId === recordingId,
    }
    const races = { zeroBoundsRejected, invalidBoundsRejected, invalidBoundsStable, titleBarRecoveries, closeRaceRecoveries }
    const passed = Object.values(continuity).every(Boolean)
      && zeroBoundsRejected && invalidBoundsRejected && invalidBoundsStable
      && titleBarRecoveries >= 1 && closeRaceRecoveries === 1
      && presentation.applied && currentOwner === 'main'
    report = {
      passed,
      platform: process.platform,
      electron: process.versions.electron,
      guestId,
      expectedPartition,
      managerIdentity,
      hostGeneration,
      checkpoints,
      continuity,
      races,
      recording: { recordingId, frameCount: frames.length, frameOwners, nonEmptyBytes: frames.reduce((sum, frame) => sum + frame.bytes, 0) },
      counters: { registerCount, unregisterCount, navigationEvents, baselineNavigationEvents, debuggerDetachCount, guestDestroyedCount, stateEventCount: stateEvents.length },
    }
    if (!passed) throw new Error(`Fixture assertions failed: ${JSON.stringify(report)}`)
  } catch (error) {
    process.stderr.write(`popout-fixture: failed ${error instanceof Error ? error.stack : String(error)}\n`)
    report = { ...report, passed: false, error: error instanceof Error ? error.stack : String(error) }
  } finally {
    process.stderr.write('popout-fixture: teardown\n')
    const remainingPopout = popoutWindow as BrowserWindow | null
    if (remainingPopout && !remainingPopout.isDestroyed()) remainingPopout.destroy()
    mainWindow.contentView.removeChildView(view)
    unregisterCount += 1
    manager.unregisterWebview(tab.tabId, guestId)
    if (!guest.isDestroyed()) guest.close()
    await waitUntil('guest teardown', () => guest.isDestroyed()).catch(() => undefined)
    await manager.destroy()
    await manager.destroy()
    if (!mainWindow.isDestroyed()) mainWindow.destroy()
    await sessions.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const finalReport = {
      ...report,
      teardown: {
        canonicalUnregisterCount: unregisterCount,
        guestDestroyed: guest.isDestroyed(),
        guestDestroyedCount,
        mainWindowDestroyed: mainWindow.isDestroyed(),
        popoutDestroyed: !remainingPopout || remainingPopout.isDestroyed(),
        repeatedManagerDestroy: true,
      },
    }
    const passed = report.passed === true
      && finalReport.teardown.guestDestroyed
      && finalReport.teardown.mainWindowDestroyed
      && finalReport.teardown.popoutDestroyed
      && unregisterCount === 1
    process.stdout.write(`FORGE_BROWSER_POPOUT_FIXTURE_RESULT=${JSON.stringify({ ...finalReport, passed })}\n`)
    app.exit(passed ? 0 : 1)
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
