import { spawn, spawnSync } from 'node:child_process'
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { EXPECTED_EXTENSION_ID } from './verify-identity.mjs'

if (process.env.FORGE_RUN_ISOLATED_CHROME !== '1') {
  throw new Error('isolated Chrome fixture is opt-in; set FORGE_RUN_ISOLATED_CHROME=1')
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceExtensionRoot = path.resolve(process.argv[2] ?? path.join(sourceRoot, 'dist/extension'))
const manifest = JSON.parse(await readFile(path.join(sourceExtensionRoot, 'manifest.json'), 'utf8'))
if (manifest.name !== 'Forge') throw new Error('isolated extension manifest name is not Forge')

async function playwrightChromeCandidates() {
  if (process.platform !== 'darwin') return []
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  try {
    const versions = (await readdir(cache, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => Number(right.slice('chromium-'.length)) - Number(left.slice('chromium-'.length)))
    return versions.flatMap((directory) => [
      path.join(cache, directory, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      path.join(cache, directory, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    ])
  } catch { return [] }
}

const systemCandidates = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? [path.join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe')]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const candidates = [
  ...(process.env.FORGE_ISOLATED_CHROME_EXECUTABLE ? [process.env.FORGE_ISOLATED_CHROME_EXECUTABLE] : []),
  ...await playwrightChromeCandidates(),
  ...systemCandidates,
]
const executable = candidates.find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0)
if (executable === undefined) throw new Error('no qualified Chrome or Chromium executable is available')
const versionResult = spawnSync(executable, ['--version'], { encoding: 'utf8' })
const version = `${versionResult.stdout}${versionResult.stderr}`.trim()
const profile = await mkdtemp(path.join(os.tmpdir(), 'forge-external-chrome-fixture-'))
const extensionRoot = path.join(profile, 'isolated-extension')
await cp(sourceExtensionRoot, extensionRoot, { recursive: true })
const bootstrapPath = path.join(extensionRoot, 'shell/service-worker-bootstrap.js')
const bootstrap = await readFile(bootstrapPath, 'utf8')
const nativeConnect = 'connect: (host) => this.chrome.runtime.connectNative(host),'
if (!bootstrap.includes(nativeConnect) || bootstrap.indexOf(nativeConnect) !== bootstrap.lastIndexOf(nativeConnect)) {
  throw new Error('isolated fixture could not uniquely block native messaging')
}
const activation = 'payload = await loaded.activateServiceWorker({ directory: selector.payloadDirectory, sha256: selector.payloadSha256 });'
if (!bootstrap.includes(activation) || bootstrap.indexOf(activation) !== bootstrap.lastIndexOf(activation)) {
  throw new Error('isolated fixture could not uniquely expose the verified payload')
}
await writeFile(bootstrapPath, bootstrap
  .replace(nativeConnect, 'connect: (_host) => { throw new Error("isolated fixture blocks native messaging") },')
  .replace(activation, `${activation}\n        Object.defineProperty(globalThis, '__forgeIsolatedFixtureRequest', { value: (request) => payload.handleIsolatedFixtureRequest(request) });\n        Object.defineProperty(globalThis, '__forgeIsolatedFixtureDiagnostics', { value: () => payload.diagnostics() });`), 'utf8')
const fixtureServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (request.url === '/child') {
    response.end('<!doctype html><title>Fixture child</title><p>Child stays outside parent authority</p>')
    return
  }
  if (request.url === '/large') {
    const buttons = Array.from({ length: 240 }, (_, index) => `<button id="large-${index}" aria-label="${`Large action ${index} ${'x'.repeat(480)}`}">Action ${index}</button>`).join('')
    response.end(`<!doctype html><title>Forge large automatic fixture</title><main>${buttons}</main><p id="large-state">Large page ready</p>`)
    return
  }
  response.end(`<!doctype html><title>Forge automatic fixture</title>
    <style>body{font:16px sans-serif}.spacer{height:1600px}</style>
    <button id="action" aria-label="Increment">Increment</button>
    <button id="child" aria-label="Open child">Open child</button>
    <a id="ordinary-link" href="/linked">Follow ordinary link</a>
    <label>Field <input id="field" aria-label="Field"></label>
    <p id="state">Ready for automatic automation</p><div class="spacer"></div><p id="bottom">Bottom</p>
    <script>
      window.__state={clicks:0,entered:0};
      action.onclick=()=>{window.__state.clicks+=1;state.textContent='Clicked '+window.__state.clicks};
      child.onclick=()=>window.open('/child','_blank');
      field.addEventListener('keydown',event=>{if(event.key==='Enter'){window.__state.entered+=1;state.textContent='Entered '+window.__state.entered}});
    </script>`)
})
await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve) })
const fixtureAddress = fixtureServer.address()
if (fixtureAddress === null || typeof fixtureAddress === 'string') throw new Error('isolated fixture server did not bind TCP')
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`
const args = [
  ...(process.env.FORGE_ISOLATED_CHROME_HEADED === '1' ? [] : ['--headless=new']),
  ...(process.env.FORGE_ISOLATED_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-search-engine-choice-screen', '--disable-sync',
  '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--window-size=1280,800', `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`, fixtureUrl,
]
let child
let stderr = ''
let evidence

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForValue(load, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await load()
      if (value !== undefined && value !== null && value !== false) return value
    } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`${description} was not ready${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function readDebuggingPort() {
  if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
    throw new Error(`isolated Chrome exited before DevTools startup${stderr ? `: ${stderr.slice(-1_024)}` : ''}`)
  }
  const value = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
  const [port] = value.trim().split('\n')
  if (!/^\d{2,5}$/u.test(port ?? '')) return undefined
  const parsed = Number(port)
  return parsed >= 1 && parsed <= 65_535 ? parsed : undefined
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.ok ? response.json() : []
}

async function workerTarget(port) {
  return (await targets(port)).find((target) => target.type === 'service_worker' && target.url === `chrome-extension://${EXPECTED_EXTENSION_ID}/shell/service-worker-bootstrap.js`)
}

async function pageTarget(port) {
  return (await targets(port)).find((target) => target.type === 'page' && target.url === fixtureUrl)
}

async function inspectWorker(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  const pending = new Map()
  const runtimeErrors = []
  let sequence = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const request = pending.get(message.id)
      if (request === undefined) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(String(message.params?.exceptionDetails?.text ?? 'worker exception'))
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      runtimeErrors.push((message.params.args ?? []).map((entry) => String(entry.value ?? entry.description ?? '')).join(' '))
    }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service-worker debugger socket timed out')), 5_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('service-worker debugger socket failed')) }, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  try {
    await send('Runtime.enable')
    await waitForValue(async () => {
      const probe = await send('Runtime.evaluate', { expression: 'globalThis.__forgeServiceWorkerBootState?.state', returnByValue: true })
      return probe.result?.value === 'ready' ? true : undefined
    }, 'service-worker payload ready')
    const evaluation = await send('Runtime.evaluate', {
      expression: `(async () => {
        const [stored, alarm] = await Promise.all([
          chrome.storage.local.get('forge.externalChrome.instanceId.v1'),
          chrome.alarms.get('forge.externalChrome.heartbeat.v2')
        ]);
        const deadline=Date.now()+10000;
        const call = async (method, params) => {
          const response = await globalThis.__forgeIsolatedFixtureRequest({jsonrpc:'2.0',id:crypto.randomUUID(),method,params});
          globalThis.__forgeIsolatedFixtureLastResponse = response;
          return response.parsed.result;
        };
        const detached = async tabId => !(await chrome.debugger.getTargets()).some(target => target.tabId === tabId && target.attached);
        let inventory={tabs:[]};
        while(Date.now()<deadline){
          inventory=await call('forge.browser.inventory',{protocolVersion:1,sessionAgentId:'fixture-session'});
          if(inventory.tabs.some(tab=>tab.url===${JSON.stringify(fixtureUrl)})) break;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        const candidate=inventory.tabs.find(tab=>tab.url===${JSON.stringify(fixtureUrl)});
        if(!candidate) throw new Error('fixture tab did not enter profile inventory');
        const acquired = await call('forge.browser.acquire',{protocolVersion:1,sessionAgentId:'fixture-session',leaseId:'fixture-root',leaseEpoch:1,tabId:candidate.tabId,createIfNeeded:false});
        const tabId = acquired.tab.tabId;
        const run = async (operation,input) => {
          const response = await call('forge.browser.execute',{protocolVersion:1,requestId:'fixture-'+operation+'-'+crypto.randomUUID(),leaseId:'fixture-root',leaseEpoch:1,tabId,operation,input,deadlineAt:new Date(Date.now()+10000).toISOString()});
          if (!response.ok) throw new Error(operation+': '+response.error.code+' '+response.error.message);
          if (await detached(tabId)) throw new Error(operation+': reusable debugger detached before turn release');
          return response.result;
        };
        const largeNavigation=await run('navigate',{url:${JSON.stringify(fixtureUrl+'large')},readiness:'load',timeoutMs:5000});
        const largeSnapshot=await run('snapshot',{});
        const largeSnapshotResponse=globalThis.__forgeIsolatedFixtureLastResponse;
        const largeStatus=await run('status',{});
        const largeEvaluate=await run('evaluate',{expression:'document.title',awaitPromise:true,returnByValue:true});
        const largeResponse=largeSnapshotResponse;
        const largeRawEnvelopeBytes=new TextEncoder().encode(JSON.stringify(largeResponse.rawEnvelope)).byteLength;
        const largeFinalEnvelopeBytes=new TextEncoder().encode(JSON.stringify(largeResponse.envelope)).byteLength;
        const largeSnapshotBytes=new TextEncoder().encode(JSON.stringify(largeSnapshot)).byteLength;
        const largeCompacted=largeSnapshot.compaction?.omitted!==undefined;
        if(largeRawEnvelopeBytes<=245760||largeFinalEnvelopeBytes>245760||!largeCompacted||largeSnapshot.screenshot?.data?.length===0||largeEvaluate.value!=='Forge large automatic fixture'||largeStatus.selectedTab?.tabId!==String(tabId)) throw new Error('large selected-tab snapshot envelope proof failed: '+JSON.stringify({largeRawEnvelopeBytes,largeFinalEnvelopeBytes,largeCompacted,screenshot:largeSnapshot.screenshot?.data?.length,largeEvaluate:largeEvaluate.value,selected:largeStatus.selectedTab?.tabId,tabId:String(tabId)}));
        const restored=await run('navigate',{url:${JSON.stringify(fixtureUrl)},readiness:'load',timeoutMs:5000});
        const snapshot=await run('snapshot',{});
        const click=await run('click',{locator:'role=button[name="Increment"]',timeoutMs:5000});
        const typed=await run('type',{locator:'role=textbox[name="Field"]',text:'forge automatic',clear:true,timeoutMs:5000});
        const pressed=await run('press',{key:'Enter',modifiers:[]});
        const scrolled=await run('scroll',{deltaX:0,deltaY:600});
        const evaluated=await run('evaluate',{expression:'({state:window.__state,value:document.querySelector("#field").value,scrollY:window.scrollY})',awaitPromise:true,returnByValue:true});
        const waited=await run('waitFor',{text:'Entered 1',timeoutMs:5000});
        const bannerPresent=async()=>Boolean((await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>document.querySelector('link[data-forge-external-status]')!==null}))[0]?.result);
        const bannerBeforeCollision=await bannerPresent();
        const collisionRequest=call('forge.browser.execute',{protocolVersion:1,requestId:'fixture-collaborative-collision',leaseId:'fixture-root',leaseEpoch:1,tabId,operation:'evaluate',input:{expression:'(()=>{window.__state.collisions=(window.__state.collisions||0)+1;return new Promise(resolve=>setTimeout(()=>resolve(window.__state.collisions),500))})()',awaitPromise:true,returnByValue:true},deadlineAt:new Date(Date.now()+5000).toISOString()});
        await new Promise(resolve=>setTimeout(resolve,100));
        await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyDown',key:'Shift',code:'ShiftLeft',modifiers:8,windowsVirtualKeyCode:16,nativeVirtualKeyCode:16});
        await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft',modifiers:0,windowsVirtualKeyCode:16,nativeVirtualKeyCode:16});
        const collision=await collisionRequest;
        const blockedAfterCollision=await call('forge.browser.execute',{protocolVersion:1,requestId:'fixture-reobserve-gate',leaseId:'fixture-root',leaseEpoch:1,tabId,operation:'evaluate',input:{expression:'window.__state.collisions+=100',awaitPromise:true,returnByValue:true},deadlineAt:new Date(Date.now()+5000).toISOString()});
        const [collisionState]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>window.__state?.collisions});
        const bannerAfterCollision=await bannerPresent();
        const reobserved=await run('snapshot',{});
        const resumedAfterObservation=await run('evaluate',{expression:'window.__state.collisions',awaitPromise:true,returnByValue:true});
        const collaborativeInput=collision.ok===false&&collision.error?.code==='control-interrupted'&&collision.error?.details?.mutationState==='possible'&&collision.error?.details?.noReplay===true&&collision.error?.details?.requiresReobserve===true&&collision.error?.details?.authorityState==='attached-idle'&&blockedAfterCollision.ok===false&&blockedAfterCollision.error?.code==='request-cancelled'&&blockedAfterCollision.error?.details?.mutationState==='not-started'&&collisionState?.result===1&&reobserved.screenshot?.data?.length>0&&resumedAfterObservation.value===1&&!(await detached(tabId));
        if(!bannerBeforeCollision||!bannerAfterCollision||!collaborativeInput) throw new Error('collaborative input continuity proof failed');
        const revealed=await call('forge.browser.reveal',{protocolVersion:1,leaseId:'fixture-root',leaseEpoch:1,tabId});
        const diagnosticsBeforeLink=globalThis.__forgeIsolatedFixtureDiagnostics();
        const [linkPoint]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>{const link=document.querySelector('#ordinary-link');if(!(link instanceof HTMLElement))return null;link.scrollIntoView({block:'center'});const rect=link.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}}});
        if(!linkPoint?.result) throw new Error('ordinary link was not available for trusted input');
        let monitorAttachment=true,sawDetachedDuringLink=false;
        const attachmentMonitor=(async()=>{while(monitorAttachment){if(await detached(tabId))sawDetachedDuringLink=true;await new Promise(resolve=>setTimeout(resolve,5));}})();
        await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x:linkPoint.result.x,y:linkPoint.result.y,button:'none'});
        await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x:linkPoint.result.x,y:linkPoint.result.y,button:'left',buttons:1,clickCount:1});
        await chrome.debugger.sendCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x:linkPoint.result.x,y:linkPoint.result.y,button:'left',buttons:0,clickCount:1});
        const linkDeadline=Date.now()+5000;
        while(Date.now()<linkDeadline&&(await chrome.tabs.get(tabId)).url!==${JSON.stringify(fixtureUrl+'linked')})await new Promise(resolve=>setTimeout(resolve,10));
        if((await chrome.tabs.get(tabId)).url!==${JSON.stringify(fixtureUrl+'linked')})throw new Error('trusted ordinary link did not navigate');
        while(Date.now()<linkDeadline&&!await bannerPresent())await new Promise(resolve=>setTimeout(resolve,10));
        monitorAttachment=false;
        await attachmentMonitor;
        const blockedAfterLink=await call('forge.browser.execute',{protocolVersion:1,requestId:'fixture-link-reobserve-gate',leaseId:'fixture-root',leaseEpoch:1,tabId,operation:'evaluate',input:{expression:'document.title="must-not-run"',awaitPromise:true,returnByValue:true},deadlineAt:new Date(Date.now()+5000).toISOString()});
        const observationDeadline=Date.now()+5000;
        let observedAfterLinkResponse;
        while(Date.now()<observationDeadline){
          observedAfterLinkResponse=await call('forge.browser.execute',{protocolVersion:1,requestId:'fixture-link-snapshot-'+crypto.randomUUID(),leaseId:'fixture-root',leaseEpoch:1,tabId,operation:'snapshot',input:{},deadlineAt:new Date(Date.now()+5000).toISOString()});
          if(observedAfterLinkResponse.ok)break;
          if(observedAfterLinkResponse.error?.code!=='request-cancelled')throw new Error('snapshot after trusted link failed: '+observedAfterLinkResponse.error?.code);
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        if(!observedAfterLinkResponse?.ok)throw new Error('snapshot after trusted link did not pass navigation revalidation');
        const observedAfterLink=observedAfterLinkResponse.result;
        const resumedAfterLink=await run('evaluate',{expression:'document.title',awaitPromise:true,returnByValue:true});
        const diagnosticsAfterLink=globalThis.__forgeIsolatedFixtureDiagnostics();
        const trustedLinkContinuity=blockedAfterLink.ok===false&&blockedAfterLink.error?.code==='request-cancelled'&&blockedAfterLink.error?.details?.requiresReobserve===true&&observedAfterLink.screenshot?.data?.length>0&&resumedAfterLink.value==='Forge automatic fixture'&&!sawDetachedDuringLink&&await bannerPresent()&&diagnosticsAfterLink.debuggerMetrics.attachments===diagnosticsBeforeLink.debuggerMetrics.attachments&&diagnosticsAfterLink.debuggerMetrics.detachments===diagnosticsBeforeLink.debuggerMetrics.detachments&&diagnosticsAfterLink.debuggerMetrics.activeAttachments===1;
        if(!trustedLinkContinuity) throw new Error('trusted ordinary-link attachment continuity proof failed');
        await run('click',{locator:'role=button[name="Increment"]',timeoutMs:5000});
        const beforeChildren=(await chrome.tabs.query({})).map(tab=>tab.id);
        await run('click',{locator:'role=button[name="Open child"]',timeoutMs:5000});
        await new Promise(resolve=>setTimeout(resolve,250));
        const afterChildren=await chrome.tabs.query({});
        const child=afterChildren.find(tab=>!beforeChildren.includes(tab.id));
        const authorityState=await chrome.storage.session.get('forge.externalChrome.tabAuthority.v2');
        const childOutsideAuthority=!!child && !(authorityState['forge.externalChrome.tabAuthority.v2']??[]).some(record=>record.tabId===child.id);
        if(child?.id) await chrome.tabs.remove(child.id);
        const released=await call('forge.browser.release',{protocolVersion:1,leaseId:'fixture-root',leaseEpoch:1,reason:'take-control'});
        const takeControlDetached=await detached(tabId);
        if (!takeControlDetached) throw new Error('Take Control did not detach reusable debugger');
        await chrome.debugger.attach({tabId},'1.3');
        await call('forge.browser.acquire',{protocolVersion:1,sessionAgentId:'fixture-conflict',leaseId:'fixture-conflict',leaseEpoch:2,tabId,createIfNeeded:false});
        const conflict=await call('forge.browser.execute',{protocolVersion:1,requestId:'fixture-conflict',leaseId:'fixture-conflict',leaseEpoch:2,tabId,operation:'click',input:{locator:'role=button[name="Increment"]',timeoutMs:5000},deadlineAt:new Date(Date.now()+10000).toISOString()});
        await chrome.debugger.detach({tabId});
        const [counterAfterConflict]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>window.__state?.clicks});
        const conflictDetails=conflict.error?.details;
        const exactConflictEvidence=conflictDetails&&Object.keys(conflictDetails).length===3&&conflictDetails.failurePhase==='debugger-attach'&&conflictDetails.mutationState==='not-started'&&conflictDetails.fallbackReason==='foreign-debugger';
        const conflictPreMutation=conflict.ok===false&&conflict.error?.code==='debugger-unavailable'&&exactConflictEvidence&&counterAfterConflict?.result===1;
        await call('forge.browser.release',{protocolVersion:1,leaseId:'fixture-conflict',leaseEpoch:2,reason:'fixture-complete'});
        const dedicated=await call('forge.browser.acquire',{protocolVersion:1,sessionAgentId:'fixture-dedicated',leaseId:'fixture-dedicated',leaseEpoch:3,createIfNeeded:true});
        const dedicatedTab=await chrome.tabs.get(dedicated.tab.tabId);
        await call('forge.browser.release',{protocolVersion:1,leaseId:'fixture-dedicated',leaseEpoch:3,reason:'fixture-complete'});
        await chrome.tabs.remove(dedicated.tab.tabId);
        const finalAuthorityState=await chrome.storage.session.get('forge.externalChrome.tabAuthority.v2');
        const zeroLeakedLease=(finalAuthorityState['forge.externalChrome.tabAuthority.v2']??[]).length===0;
        return {
          manifestName:chrome.runtime.getManifest().name,extensionId:chrome.runtime.id,
          instanceReady:typeof stored['forge.externalChrome.instanceId.v1']==='string',heartbeatReady:alarm?.name==='forge.externalChrome.heartbeat.v2',
          bootState:globalThis.__forgeServiceWorkerBootState??null,workerLocation:globalThis.location.href,
          acquisition:{acquired:acquired.created===false&&candidate.tabId===tabId,inventoryCount:inventory.tabs.length,tabId},
          operations:{snapshot:snapshot.visibleText.includes('Ready for automatic automation'),clicked:click.tabId===String(tabId),typed:typed.characters===15,pressed:pressed.key==='Enter',scrolled:scrolled.scrollY>0,evaluated:evaluated.value?.state?.clicks===1&&evaluated.value?.state?.entered===1&&evaluated.value?.value==='forge automatic',waited:waited.matched===true,revealed:revealed.revealed===true&&revealed.tabId===tabId},
          largePage:{navigated:restored.tab.tabId===String(tabId)&&largeNavigation.readiness==='load',snapshotSucceeded:largeSnapshot.screenshot?.data?.length>0,snapshotBytes:largeSnapshotBytes,rawEnvelopeBytes:largeRawEnvelopeBytes,finalEnvelopeBytes:largeFinalEnvelopeBytes,snapshotCompacted:largeCompacted,parserAccepted:largeResponse.parsed.result?.ok===true,statusSticky:largeStatus.selectedTab?.tabId===String(tabId),evaluateFollowed:largeEvaluate.value==='Forge large automatic fixture'},
          collaboration:{collision:collaborativeInput,bannerContinuous:bannerBeforeCollision&&bannerAfterCollision,reobserved:reobserved.screenshot?.data?.length>0,resumed:resumedAfterObservation.value===1,trustedLinkContinuity},
          takeControl:{detached:takeControlDetached},
          childPolicy:{opened:!!child,outsideAuthority:childOutsideAuthority},
          debuggerConflict:{preMutation:conflictPreMutation,exactEvidence:exactConflictEvidence},
          dedicated:{created:dedicated.created===true,ungrouped:dedicatedTab.groupId===-1},
          released:released.releasedTabIds.length===1&&released.releasedTabIds[0]===tabId,
          debuggerDetached:await detached(tabId),zeroLeakedLease
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (evaluation.exceptionDetails) throw new Error(`worker evaluation failed: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`)
    return { state: evaluation.result?.value, acquisition: evaluation.result?.value?.acquisition, runtimeErrors }
  } finally {
    socket.close()
  }
}

function processGroupAlive(pid) {
  if (process.platform === 'win32') return false
  try { process.kill(-pid, 0); return true } catch { return false }
}

try {
  child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  })
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 131_072) stderr += String(chunk).slice(0, 131_072 - stderr.length)
  })
  child.once('error', (error) => { stderr += `\nspawn error: ${error.message}` })

  const debuggingPort = await waitForValue(readDebuggingPort, 'ephemeral DevTools port')
  const target = await waitForValue(() => workerTarget(debuggingPort), 'Forge service-worker target')
  await waitForValue(() => pageTarget(debuggingPort), 'fixture page target')
  const inspected = await inspectWorker(target.webSocketDebuggerUrl)
  const state = inspected.state
  if (state?.manifestName !== 'Forge' || state?.extensionId !== EXPECTED_EXTENSION_ID) throw new Error('worker reported an unexpected Forge identity')
  if (state?.instanceReady !== true || state?.heartbeatReady !== true || state?.bootState?.state !== 'ready') {
    throw new Error(`Forge payload did not reach ready state: ${JSON.stringify(state)}`)
  }
  if (state.workerLocation !== target.url) throw new Error('worker target URL and runtime location disagree')
  if (state.acquisition?.acquired !== true || state.debuggerDetached !== true || state.released !== true || state.zeroLeakedLease !== true ||
    Object.values(state.operations ?? {}).some((value) => value !== true) ||
    state.largePage?.navigated !== true || state.largePage?.snapshotSucceeded !== true || state.largePage?.statusSticky !== true ||
    state.largePage?.evaluateFollowed !== true || state.largePage?.snapshotCompacted !== true || state.largePage?.parserAccepted !== true ||
    state.collaboration?.collision !== true || state.collaboration?.bannerContinuous !== true || state.collaboration?.reobserved !== true || state.collaboration?.resumed !== true || state.collaboration?.trustedLinkContinuity !== true ||
    state.takeControl?.detached !== true || state.childPolicy?.opened !== true || state.childPolicy?.outsideAuthority !== true ||
    state.debuggerConflict?.preMutation !== true || state.debuggerConflict?.exactEvidence !== true ||
    state.dedicated?.created !== true || state.dedicated?.ungrouped !== true) {
    throw new Error(`isolated automatic runtime proof failed: ${JSON.stringify(state)}`)
  }
  const bootErrors = [...inspected.runtimeErrors, stderr].filter((value) => /Forge payload failed to boot|importScripts/iu.test(value))
  if (bootErrors.length > 0) throw new Error(`Forge worker reported a payload boot error: ${bootErrors.join(' | ').slice(0, 512)}`)
  evidence = {
    version,
    executable,
    arguments: args.map((argument) => argument.includes(profile) ? argument.replace(profile, '<deleted-isolated-profile>') : argument),
    debuggingPort,
    extensionId: state.extensionId,
    manifestName: state.manifestName,
    workerTarget: target.url,
    payloadBootState: state.bootState.state,
    instanceReady: state.instanceReady,
    heartbeatReady: state.heartbeatReady,
    nativeMessaging: 'fixture-blocked',
    importScriptsBootError: false,
    operations: { acquired: true, ...state.operations, released: state.released, debuggerDetached: state.debuggerDetached, zeroLeakedLease: state.zeroLeakedLease },
    largePage: state.largePage,
    collaboration: state.collaboration,
    takeControl: state.takeControl,
    allocation: { inventoryReuse: state.acquisition.acquired, inventoryCount: state.acquisition.inventoryCount, dedicatedCreated: state.dedicated.created, dedicatedUngrouped: state.dedicated.ungrouped },
    childPolicy: state.childPolicy,
    debuggerConflict: state.debuggerConflict,
  }
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(2_000),
    ])
  }
  if (child !== undefined && process.platform !== 'win32' && processGroupAlive(child.pid)) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already stopped */ }
    await waitForValue(() => !processGroupAlive(child.pid), 'isolated Chrome process-group shutdown', 5_000).catch(() => undefined)
  }
  await rm(profile, { recursive: true, force: true })
  fixtureServer.closeAllConnections?.()
  fixtureServer.close()
}

let profileRemoved = false
try { await access(profile) } catch { profileRemoved = true }
if (!profileRemoved) throw new Error('isolated Chrome profile cleanup failed')
if (child !== undefined && process.platform !== 'win32' && processGroupAlive(child.pid)) throw new Error('isolated Chrome process group is still running')
if (evidence === undefined) throw new Error(`isolated Chrome verification failed${stderr ? `: ${stderr.slice(-1_024)}` : ''}`)
process.stdout.write(`${JSON.stringify({ ...evidence, processStopped: true, profileRemoved: true })}\n`)
