// Real-Chrome regression: a password manager's inline autofill menu is a chrome-extension:// iframe
// that appears while a form field is focused. Chrome force-detaches the Forge debugger when that
// frame appears and refuses every reattach while it remains. After the lease is lost and
// re-acquired, the next operation must dismiss the focus-bound overlay and regain control.
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

// Minimal stand-in for Bitwarden/1Password inline menus: a focus-bound extension iframe.
const autofillRoot = path.join(profile, 'autofill-extension')
await mkdir(autofillRoot)
await writeFile(path.join(autofillRoot, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Fixture autofill menu',
  version: '1.0.0',
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle' }],
  web_accessible_resources: [{ resources: ['menu.html'], matches: ['http://127.0.0.1/*'] }],
}))
await writeFile(path.join(autofillRoot, 'menu.html'), '<!doctype html><p>Autofill menu</p>')
await writeFile(path.join(autofillRoot, 'content.js'), `
  let menu = null
  let pending = null
  // Real inline menus open after an async round trip to their extension, so typing completes first.
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLInputElement) || menu !== null) return
    pending = setTimeout(() => {
      menu = document.createElement('iframe')
      menu.src = chrome.runtime.getURL('menu.html')
      menu.style.cssText = 'position:fixed;top:0;right:0;width:200px;height:80px;border:0'
      document.documentElement.append(menu)
    }, 150)
  })
  document.addEventListener('focusout', () => { clearTimeout(pending); menu?.remove(); menu = null })
  // A persistent frame (not focus-bound) cannot be dismissed and must produce the specific refusal.
  new MutationObserver(() => {
    if (document.body?.dataset.persistentMenu !== '1' || document.getElementById('persistent-menu')) return
    const frame = document.createElement('iframe')
    frame.id = 'persistent-menu'
    frame.src = chrome.runtime.getURL('menu.html')
    document.documentElement.append(frame)
  }).observe(document.documentElement, { attributes: true, subtree: true })
`)

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end('<!doctype html><title>Forge foreign frame fixture</title><label>Name <input id="name"></label>')
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
        const execute = async (leaseId, leaseEpoch, tabId, operation, input) => (await call('forge.browser.execute', { protocolVersion: 1, requestId: crypto.randomUUID(), leaseId, leaseEpoch, tabId, operation, input, deadlineAt: new Date(Date.now() + 10000).toISOString() })).result;
        const acquire = async (leaseId, leaseEpoch, tabId) => (await call('forge.browser.acquire', { protocolVersion: 1, sessionAgentId: 'fixture', leaseId, leaseEpoch, tabId, createIfNeeded: false })).result;
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
        const acquired = await acquire('first-lease', 1, candidate.tabId)
        if (!acquired) throw new Error('acquire failed')
        return acquired.tab.tabId
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('fixture tab did not enter inventory')`)

  const state = await inWorker(`
    const summarize = (outcome) => outcome?.ok ? { ok: true } : { ok: false, code: outcome?.error?.code, message: outcome?.error?.message }
    // Focusing the field makes the stand-in autofill extension inject its frame.
    const typed = summarize(await execute('first-lease', 1, ${tabId}, 'type', { selector: '#name', text: 'workcomp', clear: true, timeoutMs: 5000 }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const afterOverlay = summarize(await execute('first-lease', 1, ${tabId}, 'evaluate', { expression: 'document.title', awaitPromise: false, returnByValue: true }))
    // The agent's documented recovery: re-open the same tab under a fresh lease and continue.
    const reacquired = await acquire('second-lease', 2, ${tabId})
    const recovered = await execute('second-lease', 2, ${tabId}, 'evaluate', { expression: '({ value: document.querySelector("#name").value, overlayFrames: document.querySelectorAll("iframe").length })', awaitPromise: false, returnByValue: true })
    await execute('second-lease', 2, ${tabId}, 'evaluate', { expression: 'document.body.dataset.persistentMenu = "1"', awaitPromise: false, returnByValue: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await acquire('third-lease', 3, ${tabId})
    const persistentStartedAt = Date.now()
    const persistent = summarize(await execute('third-lease', 3, ${tabId}, 'snapshot', {}))
    const persistentMs = Date.now() - persistentStartedAt
    return {
      persistent,
      persistentMs,
      typed,
      afterOverlay,
      reacquired: reacquired?.tab?.tabId === ${tabId},
      recovered: summarize(recovered),
      recoveredValue: recovered?.ok ? recovered.result.value : null,
      detachReasons: globalThis.__forgeIsolatedFixtureDiagnostics().debuggerMetrics.detachReasons,
    }`)
  worker.close()
  evidence = { executable: path.basename(executable), version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(), ...state }
  // Production sequence: type succeeds, Chrome detaches when the menu appears, re-open recovers.
  if (!state.typed.ok || state.afterOverlay.code !== 'lease-lost' || !state.reacquired || !state.recovered.ok || state.recoveredValue?.value !== 'workcomp' || state.recoveredValue?.overlayFrames !== 0 ||
    // A frame that survives the dismissal is reported specifically instead of as an opaque failure.
    state.persistent.code !== 'debugger-unavailable' || !/password manager autofill menu/u.test(state.persistent.message ?? '')) {
    throw new Error(`foreign-extension-frame recovery proof failed: ${JSON.stringify(evidence)}`)
  }
} finally {
  try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch { /* already stopped */ }
  await delay(500)
  await rm(profile, { recursive: true, force: true })
  server.closeAllConnections?.()
  server.close()
}
process.stdout.write(`${JSON.stringify(evidence)}\n`)
