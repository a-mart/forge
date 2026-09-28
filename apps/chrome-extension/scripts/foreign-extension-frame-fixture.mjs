// Real-Chrome regression: a password manager's inline autofill menu is a chrome-extension:// iframe
// that appears while a form field is focused. Chrome force-detaches the Forge debugger when that
// frame appears and refuses every reattach while it remains. After the lease is lost and
// re-acquired, the next operation must remove the foreign frame and regain control, including when
// the page keeps focus in the field, hides the frame in a closed shadow root, or nests it in a child
// frame. A frame its extension keeps re-adding must fail specifically and name that extension.
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.FORGE_RUN_ISOLATED_CHROME !== '1') {
  throw new Error('foreign-extension-frame fixture is opt-in; set FORGE_RUN_ISOLATED_CHROME=1')
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceExtensionRoot = path.resolve(process.argv[2] ?? path.join(sourceRoot, 'dist/extension'))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function chromeCandidates() {
  const candidates = process.env.FORGE_ISOLATED_CHROME_EXECUTABLE ? [process.env.FORGE_ISOLATED_CHROME_EXECUTABLE] : []
  if (process.platform === 'darwin') {
    // Branded Chrome ignores --load-extension, so prefer Chrome for Testing.
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
    const versions = await readdir(cache).catch(() => [])
    for (const directory of versions.filter((name) => /^chromium-\d+$/u.test(name)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))) {
      candidates.push(path.join(cache, directory, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
    }
  }
  return candidates
}
const executable = (await chromeCandidates()).find((candidate) => spawnSync(candidate, ['--version']).status === 0)
if (executable === undefined) throw new Error('no Chrome for Testing executable; set FORGE_ISOLATED_CHROME_EXECUTABLE')

const profile = await mkdtemp(path.join(os.tmpdir(), 'forge-foreign-frame-'))
const extensionRoot = path.join(profile, 'isolated-extension')
await cp(sourceExtensionRoot, extensionRoot, { recursive: true })
const bootstrapPath = path.join(extensionRoot, 'shell/service-worker-bootstrap.js')
const bootstrap = await readFile(bootstrapPath, 'utf8')
const nativeConnect = 'connect: (host) => this.chrome.runtime.connectNative(host),'
const activation = 'payload = await loaded.activateServiceWorker({ directory: selector.payloadDirectory, sha256: selector.payloadSha256 });'
if (!bootstrap.includes(nativeConnect) || !bootstrap.includes(activation)) throw new Error('fixture could not patch the worker bootstrap')
await writeFile(bootstrapPath, bootstrap
  .replace(nativeConnect, 'connect: (_host) => { throw new Error("isolated fixture blocks native messaging") },')
  .replace(activation, `${activation}\n        Object.defineProperty(globalThis, '__forgeIsolatedFixtureRequest', { value: (request) => payload.handleIsolatedFixtureRequest(request) });\n        Object.defineProperty(globalThis, '__forgeIsolatedFixtureDiagnostics', { value: () => payload.diagnostics() });`))

// Stand-in for Bitwarden/1Password inline menus. Page paths select the menu behavior.
const autofillRoot = path.join(profile, 'autofill-extension')
await mkdir(autofillRoot)
await writeFile(path.join(autofillRoot, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Fixture autofill menu',
  version: '1.0.0',
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle', all_frames: true }],
  web_accessible_resources: [{ resources: ['menu.html'], matches: ['http://127.0.0.1/*'] }],
}))
await writeFile(path.join(autofillRoot, 'menu.html'), '<!doctype html><p>Autofill menu</p>')
await writeFile(path.join(autofillRoot, 'content.js'), `
  const menuFrame = () => {
    const frame = document.createElement('iframe')
    frame.src = chrome.runtime.getURL('menu.html')
    return frame
  }
  let menu = null
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLInputElement) || menu !== null) return
    // Real inline menus open after an async round trip to their extension, so typing completes first.
    setTimeout(() => {
      if (location.pathname === '/shadow') {
        // Bitwarden-style: a hidden frame inside a closed shadow root that stays after blur.
        menu = document.createElement('fixture-menu')
        const frame = menuFrame()
        frame.style.display = 'none'
        menu.attachShadow({ mode: 'closed' }).append(frame)
      } else {
        menu = menuFrame()
      }
      document.documentElement.append(menu)
      if (location.pathname === '/sticky') {
        // An extension that re-adds its frame whenever it is removed cannot be recovered.
        new MutationObserver(() => { if (!menu.isConnected) document.documentElement.append(menu = menuFrame()) })
          .observe(document.documentElement, { childList: true })
      }
    }, 150)
  })
  document.addEventListener('focusout', () => {
    if (location.pathname !== '/' || menu === null) return
    menu.remove()
    menu = null
  })
`)

const pages = {
  '/': '<input id="name">',
  // Cloudflare-style form: focus returns to the field whenever it leaves.
  '/shadow': '<input id="name"><script>name.addEventListener("blur", () => setTimeout(() => name.focus()))</script>',
  '/nested': '<iframe id="child" src="/child"></iframe>',
  '/child': '<input id="name">',
  '/sticky': '<input id="name">',
}
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`<!doctype html><title>Forge foreign frame fixture</title>${pages[new URL(request.url, 'http://127.0.0.1').pathname] ?? ''}`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`
const child = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
  '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionRoot},${autofillRoot}`, `--load-extension=${extensionRoot},${autofillRoot}`, fixtureUrl,
], { stdio: 'ignore', detached: process.platform !== 'win32' })

async function waitFor(load, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const value = await load(); if (value) return value } catch { /* retry */ }
    await delay(100)
  }
  throw new Error(`${label} was not ready`)
}

async function devtools(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let sequence = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (request === undefined) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('DevTools socket failed')) })
  return {
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    }),
  }
}

let evidence
try {
  const port = await waitFor(async () => Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), 'DevTools port')
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const workerTarget = await waitFor(async () => (await targets()).find((target) => target.type === 'service_worker' && target.url.endsWith('/shell/service-worker-bootstrap.js')), 'Forge worker')
  await waitFor(async () => (await targets()).find((target) => target.type === 'page' && target.url === fixtureUrl), 'fixture page')
  const worker = await devtools(workerTarget.webSocketDebuggerUrl)
  await waitFor(async () => (await worker.send('Runtime.evaluate', { expression: 'globalThis.__forgeServiceWorkerBootState?.state', returnByValue: true })).result?.value === 'ready', 'Forge payload')
  const inWorker = async (body) => {
    const evaluation = await worker.send('Runtime.evaluate', {
      expression: `(async () => {
        const call = async (method, params) => (await globalThis.__forgeIsolatedFixtureRequest({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })).parsed;
        const execute = async (leaseId, leaseEpoch, tabId, operation, input) => {
          try { return (await call('forge.browser.execute', { protocolVersion: 1, requestId: crypto.randomUUID(), leaseId, leaseEpoch, tabId, operation, input, deadlineAt: new Date(Date.now() + 10000).toISOString() })).result }
          catch (error) { return { ok: false, error: { code: 'thrown', message: error.message } } }
        };
        const acquire = async (leaseId, leaseEpoch, tabId) => {
          try { return (await call('forge.browser.acquire', { protocolVersion: 1, sessionAgentId: 'fixture', leaseId, leaseEpoch, tabId, createIfNeeded: false })).result }
          catch (error) { throw new Error(leaseId + ': ' + error.message + ' ' + JSON.stringify(globalThis.__forgeIsolatedFixtureDiagnostics().authorities)) }
        };
        ${body}
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text)
    return evaluation.result.value
  }
  const tabId = await inWorker(`
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const inventory = (await call('forge.browser.inventory', { protocolVersion: 1, sessionAgentId: 'fixture' })).result
      const candidate = inventory.tabs.find((tab) => tab.url === ${JSON.stringify(fixtureUrl)})
      if (candidate) {
        const acquired = await acquire('lease-1', 1, candidate.tabId)
        if (!acquired) throw new Error('acquire failed')
        return acquired.tab.tabId
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('fixture tab did not enter inventory')`)

  const state = await inWorker(`
    const summarize = (outcome) => outcome?.ok ? { ok: true, value: outcome.result?.value } : { ok: false, code: outcome?.error?.code, message: outcome?.error?.message }
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const fieldState = (inChild) => inChild
      ? '({ value: child.contentDocument.querySelector("#name").value, focused: child.contentDocument.activeElement?.id ?? null })'
      : '({ value: document.querySelector("#name").value, focused: document.activeElement?.id ?? null })'
    let epoch = 1
    const scenario = async (pathname, typeTarget, inChild = false) => {
      const lease = 'lease-' + epoch
      if (epoch > 1 && !(await acquire(lease, epoch, ${tabId}))) throw new Error('acquire failed for ' + pathname)
      // Navigation also runs the recovery when the previous page still holds a foreign frame.
      const navigated = summarize(await execute(lease, epoch, ${tabId}, 'navigate', { url: ${JSON.stringify(fixtureUrl)}.replace(/\\/$/, pathname), readiness: 'load', timeoutMs: 5000 }))
      const typed = summarize(await execute(lease, epoch, ${tabId}, typeTarget.operation, typeTarget.input))
      await pause(500)
      const afterMenu = summarize(await execute(lease, epoch, ${tabId}, 'evaluate', { expression: 'document.title', awaitPromise: false, returnByValue: true }))
      await call('forge.browser.release', { protocolVersion: 1, leaseId: lease, leaseEpoch: epoch, reason: 'operation-failed' }).catch(() => undefined)
      epoch += 1
      // The agent's documented recovery: re-open the same tab under a fresh lease and continue.
      const reopened = 'lease-' + epoch
      if (!(await acquire(reopened, epoch, ${tabId}))) throw new Error('re-acquire failed for ' + pathname)
      const startedAt = Date.now()
      const recovered = summarize(await execute(reopened, epoch, ${tabId}, 'evaluate', { expression: fieldState(inChild), awaitPromise: false, returnByValue: true }))
      const recoveryMs = Date.now() - startedAt
      const released = await call('forge.browser.release', { protocolVersion: 1, leaseId: reopened, leaseEpoch: epoch, reason: 'operation-failed' })
        .then((response) => response.error ? response.error.message : 'released', (error) => 'threw: ' + error.message)
      const diagnostics = globalThis.__forgeIsolatedFixtureDiagnostics()
      epoch += 1
      return { navigated, typed, afterMenu, recovered, recoveryMs, released, authorities: diagnostics.authorities }
    }
    const typeInto = { operation: 'type', input: { selector: '#name', text: 'workcomp', clear: true, timeoutMs: 5000 } }
    // A same-origin child frame is focused through the page, as a user click would.
    const focusChild = { operation: 'evaluate', input: { expression: 'child.contentDocument.querySelector("#name").value = "workcomp"; child.contentDocument.querySelector("#name").focus(); true', awaitPromise: false, returnByValue: true } }
    return {
      focusBound: await scenario('/', typeInto),
      focusTrappedShadow: await scenario('/shadow', typeInto),
      nestedChild: await scenario('/nested', focusChild, true),
      sticky: await scenario('/sticky', typeInto),
      detachReasons: globalThis.__forgeIsolatedFixtureDiagnostics().debuggerMetrics.detachReasons,
    }`)
  worker.close()
  evidence = { executable: path.basename(executable), version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(), ...state }
  const recoveredField = (result, focused) => result.navigated.ok && result.typed.ok && result.afterMenu.code === 'lease-lost' &&
    result.recovered.ok && result.recovered.value?.value === 'workcomp' && result.recovered.value?.focused === focused
  const failures = [
    // Production sequence: the step succeeds, Chrome detaches when the menu appears, re-open recovers.
    !recoveredField(state.focusBound, 'name') && 'focus-bound menu',
    // Focus stays in the field; removing the frame, not blurring, is what restores control.
    !recoveredField(state.focusTrappedShadow, 'name') && 'focus-trapped closed-shadow frame',
    !recoveredField(state.nestedChild, 'name') && 'same-origin child frame',
    // A frame that keeps coming back fails specifically and names the extension to disable.
    !(state.sticky.recovered.code === 'debugger-unavailable' && /chrome-extension:\/\/[a-p]{32}/u.test(state.sticky.recovered.message ?? '')) && 'sticky frame refusal',
    // Chrome also refuses detach while the frame exists; release must still complete.
    ...['focusBound', 'focusTrappedShadow', 'nestedChild', 'sticky'].map((name) =>
      (state[name].released !== 'released' || state[name].authorities.length !== 0) && `${name} release`),
  ].filter(Boolean)
  if (failures.length > 0) {
    throw new Error(`foreign-extension-frame recovery proof failed (${failures.join(', ')}): ${JSON.stringify(evidence)}`)
  }
} finally {
  try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch { /* already stopped */ }
  await delay(500)
  await rm(profile, { recursive: true, force: true })
  server.closeAllConnections?.()
  server.close()
}
process.stdout.write(`${JSON.stringify(evidence)}\n`)
