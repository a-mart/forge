import { app, BrowserWindow, ipcMain, webContents } from 'electron'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { BrowserAutomationManager } from './browser-automation-manager.js'
import { installBrowserIpc } from './browser-ipc.js'
import { BrowserSessionRegistry } from './browser-session.js'
import { ManagedBrowserViewHost } from './managed-browser-view-host.js'

const root = process.env.FORGE_BROWSER_FIXTURE_ROOT
if (!root) throw new Error('FORGE_BROWSER_FIXTURE_ROOT is required')
mkdirSync(root, { recursive: true })
app.setPath('userData', path.join(root, 'electron-user-data'))
app.commandLine.appendSwitch('disable-background-timer-throttling')

const fixtureHtml = `<!doctype html><html><head><title>Forge Browser Fixture</title><style>body{font:16px sans-serif;height:1600px}button,input{margin:8px;padding:8px}</style></head><body>
<button id="increment" aria-label="Increment">Increment</button><label>Message<input id="message" aria-label="Message"></label><div id="delayed"></div><output id="state"></output>
<script>const state={clicks:0,keys:0,keyDowns:0,keyUps:0};const render=()=>stateEl.textContent=JSON.stringify({...state,typed:message.value});const stateEl=document.querySelector('#state');increment.onclick=()=>{state.clicks++;render()};message.oninput=render;message.onkeydown=e=>{state.keyDowns++;if(e.key==='Enter')state.keys++;render()};message.onkeyup=()=>{state.keyUps++;render()};setTimeout(()=>{delayed.textContent='Ready for automation'},100);render();window.animateFixture=()=>{let i=0;const timer=setInterval(()=>{document.body.style.backgroundColor=i++%2?'#fff':'#eef';if(i>20)clearInterval(timer)},30)}</script></body></html>`

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP')
  return address.port
}

void app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); response.end(fixtureHtml) })
  const port = await listen(server)
  ipcMain.on('forge:get-backend-bootstrap', (event) => { event.returnValue = { backendUrl: 'http://127.0.0.1:1', backendWsUrl: 'ws://127.0.0.1:1', version: 'fixture', platform: process.platform, windowRole: 'main', managedBrowserPopoutAvailable: true } })
  const window = new BrowserWindow({ show: false, width: 1_000, height: 800, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } })
  const sessions = new BrowserSessionRegistry()
  const guestPreloadPath = path.join(__dirname, 'guest-preload.js')
  const manager = new BrowserAutomationManager({ approvedDataRoot: root, hostWebContentsId: window.webContents.id, sendToRenderer: (channel, payload) => window.webContents.send(channel, payload) })
  const viewHost = new ManagedBrowserViewHost({ manager, sessions, guestPreloadPath })
  const dispose = installBrowserIpc({ ipcMain, mainWindow: window, manager, viewHost })
  let settled = false
  const finish = async (code: number, report: unknown): Promise<void> => {
    if (settled) return
    settled = true
    dispose()
    if (!window.isDestroyed()) window.destroy()
    await manager.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const result = report && typeof report === 'object' ? report as Record<string, unknown> : { report }
    const close = result.close && typeof result.close === 'object' ? result.close as Record<string, unknown> : {}
    const finalReport = {
      ...result,
      passed: result.passed === true && window.isDestroyed(),
      close: { ...close, hostWindowDestroyed: window.isDestroyed(), repeatedManagerDestroy: true },
    }
    process.stdout.write(`FORGE_BROWSER_FIXTURE_RESULT=${JSON.stringify(finalReport)}\n`)
    app.exit(code)
  }
  window.webContents.on('console-message', (_event, detailsOrLevel: unknown, message?: string) => {
    const text = typeof detailsOrLevel === 'object' && detailsOrLevel && 'message' in detailsOrLevel ? String((detailsOrLevel as { message: unknown }).message) : String(message ?? '')
    if (text === 'FORGE_BROWSER_FIXTURE_INTERRUPT') {
      const guest = webContents.getAllWebContents().find((contents) => contents.id !== window.webContents.id && contents.getURL().includes('/fixture'))
      guest?.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
      guest?.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
      return
    }
    if (!text.startsWith('FORGE_BROWSER_FIXTURE_PAGE=')) return
    const raw = text.slice('FORGE_BROWSER_FIXTURE_PAGE='.length)
    let report: unknown = raw
    try { report = JSON.parse(raw) } catch { /* retain renderer diagnostic */ }
    void finish(raw.includes('"passed":true') ? 0 : 1, report)
  })
  setTimeout(() => { void finish(1, { passed: false, error: 'fixture timeout' }) }, 30_000).unref()

  const fixtureUrl = `http://127.0.0.1:${port}/fixture`
  const renderer = `<!doctype html><html><body><script>
  (async()=>{try{
    const bridge=window.electronBridge.browserAutomation;
    const now=new Date().toISOString();const tab={tabId:'fixture-tab',sessionAgentId:'fixture-session',profileId:'fixture-profile',url:${JSON.stringify(fixtureUrl)},title:'Forge Browser Fixture',lifecycle:'ready',loading:false,live:false,canGoBack:false,canGoForward:false,zoomFactor:1,controller:'none',agentCursor:null,recording:null,viewportSetting:{mode:'fill'},renderedViewport:null,error:null,createdAt:now,updatedAt:now};
    const session={schemaVersion:1,sessionAgentId:'fixture-session',profileId:'fixture-profile',hostingState:'hosted',tabs:[tab],activeTabId:'fixture-tab',defaultTabId:'fixture-tab',panelVisible:true,recentActions:[],revision:1,createdAt:now,updatedAt:now};
    await bridge.reconcile({controllerInstanceId:'fixture-controller',hostGeneration:1,updateSequence:1,workspaceEpoch:1,sessions:[session]});
    await bridge.reportViewport({workspaceEpoch:1,rect:{x:0,y:0,width:800,height:600},innerWidth:window.innerWidth,innerHeight:window.innerHeight});
    const presentation=await bridge.setTabPresentation({tabId:'fixture-tab',visible:true,viewportSetting:{mode:'fill'},renderedViewport:{width:800,height:600,deviceScaleFactor:window.devicePixelRatio||1},hostGeneration:1,sessionRevision:1,sequence:1,workspaceEpoch:1});
    let seq=0;const call=async(operation,input,artifactDirectory=null)=>bridge.invoke({requestId:'fixture-'+(++seq),sessionAgentId:'fixture-session',profileId:'fixture-profile',tabId:operation==='status'?'fixture-tab':'fixture-tab',hostId:'fixture-host',hostGeneration:1,deadlineAt:new Date(Date.now()+15000).toISOString(),artifactDirectory,operation,input});
    const responses=[];responses.push(await call('status',{}));responses.push(await call('open',{url:${JSON.stringify(fixtureUrl)},show:true,reuseExistingTab:true}));responses.push(await call('navigate',{url:${JSON.stringify(fixtureUrl)},readiness:'load',timeoutMs:5000}));responses.push(await call('resize',{mode:'freeform',width:800,height:600,timeoutMs:5000}));responses.push(await call('snapshot',{}));responses.push(await call('click',{locator:"role=button[name='Increment']",timeoutMs:5000}));responses.push(await call('type',{locator:"role=textbox[name='Message']",text:'fixture typed',clear:true,timeoutMs:5000}));responses.push(await call('press',{key:'Enter',modifiers:[]}));const printable=await call('press',{key:'a',modifiers:[]});responses.push(await call('scroll',{deltaY:100}));responses.push(await call('evaluate',{expression:'window.animateFixture(); JSON.parse(document.querySelector(\"#state\").textContent)',awaitPromise:true,returnByValue:true}));responses.push(await call('waitFor',{text:'Ready for automation',timeoutMs:5000}));
    const interruptedPromise=call('waitFor',{text:'Never appears',timeoutMs:2000});setTimeout(()=>console.log('FORGE_BROWSER_FIXTURE_INTERRUPT'),50);const interrupted=await interruptedPromise;
    await bridge.setTabPresentation({tabId:'fixture-tab',visible:false,renderedViewport:null,hostGeneration:1,sessionRevision:2,sequence:2,workspaceEpoch:1});const typedFailure=await call('recordingStart',{});await bridge.setTabPresentation({tabId:'fixture-tab',visible:true,viewportSetting:{mode:'freeform',width:800,height:600},renderedViewport:{width:800,height:600,deviceScaleFactor:window.devicePixelRatio||1},hostGeneration:1,sessionRevision:3,sequence:3,workspaceEpoch:1});
    const started=await call('recordingStart',{});responses.push(started);await new Promise(resolve=>setTimeout(resolve,1200));const recordingId=started.ok?started.result.recordingId:undefined;responses.push(await call('recordingStop',{recordingId},${JSON.stringify(path.join(root, 'artifacts', 'browser'))}));
    const unhosted={...session,hostingState:'unhosted',revision:2};await bridge.reconcile({controllerInstanceId:'fixture-controller',hostGeneration:1,updateSequence:2,workspaceEpoch:1,sessions:[unhosted]});await bridge.reconcile({controllerInstanceId:'fixture-controller',hostGeneration:1,updateSequence:3,workspaceEpoch:1,sessions:[unhosted]});const postCloseStatus=await call('status',{});
    const failures=responses.filter(response=>!response.ok).map(response=>({operation:response.operation,error:response.error}));const status=responses.find(response=>response.operation==='status');const evaluated=responses.find(response=>response.operation==='evaluate');const snapshot=responses.find(response=>response.operation==='snapshot');const stopped=responses.find(response=>response.operation==='recordingStop');const close={repeatedUnregister:true,webviewDetached:true,tabUnavailable:postCloseStatus.ok&&postCloseStatus.operation==='status'&&postCloseStatus.result.selectedTab===null&&postCloseStatus.result.physicalTabVisible===false};
    const passed=failures.length===0&&presentation.applied===true&&status?.result?.physicalTabVisible===true&&status?.result?.panelVisible===true&&evaluated?.result?.value?.clicks===1&&evaluated?.result?.value?.keys===1&&evaluated?.result?.value?.keyDowns>=2&&evaluated?.result?.value?.keyUps>=2&&evaluated?.result?.value?.typed==='fixture typeda'&&printable.ok&&snapshot?.result?.screenshot?.data?.length>0&&typedFailure?.error?.code==='recording-requires-visible-tab'&&typedFailure?.error?.retryable===true&&interrupted?.error?.code==='control-interrupted'&&stopped?.result?.sizeBytes>0&&close.tabUnavailable;
    console.log('FORGE_BROWSER_FIXTURE_PAGE='+JSON.stringify({passed,operations:responses.map(response=>response.operation),failures,visibility:{presentation,status:status?.result},typedFailure:typedFailure.ok?null:typedFailure.error,interruption:interrupted.ok?null:interrupted.error,keyboard:evaluated?.result?.value,recording:stopped?.ok?{mimeType:stopped.result.mimeType,sizeBytes:stopped.result.sizeBytes,path:stopped.result.path}:null,close}));
  }catch(error){console.log('FORGE_BROWSER_FIXTURE_PAGE='+JSON.stringify({passed:false,error:error?.stack||String(error)}))}})();
  </script></body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderer)}`)
}).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); app.exit(1) })
