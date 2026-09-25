// Real-Chrome regression: a lease whose debugger setup is stuck on a hung renderer must still
// release. Chrome acknowledges chrome.debugger.attach browser-side, but Page.enable waits on the
// renderer main thread until the extension detaches. Release must detach instead of waiting.
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.FORGE_RUN_ISOLATED_CHROME !== '1') {
  throw new Error('hung-renderer fixture is opt-in; set FORGE_RUN_ISOLATED_CHROME=1')
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

const profile = await mkdtemp(path.join(os.tmpdir(), 'forge-hung-renderer-'))
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

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end('<!doctype html><title>Forge hung renderer fixture</title><p>hung</p>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`
const child = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
  '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`, fixtureUrl,
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
  const pageTarget = await waitFor(async () => (await targets()).find((target) => target.type === 'page' && target.url === fixtureUrl), 'fixture page')
  const worker = await devtools(workerTarget.webSocketDebuggerUrl)
  await waitFor(async () => (await worker.send('Runtime.evaluate', { expression: 'globalThis.__forgeServiceWorkerBootState?.state', returnByValue: true })).result?.value === 'ready', 'Forge payload')
  const inWorker = async (body) => {
    const evaluation = await worker.send('Runtime.evaluate', {
      expression: `(async () => {
        const call = async (method, params) => (await globalThis.__forgeIsolatedFixtureRequest({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })).parsed;
        const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('pending'), ms))]);
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
        const acquired = await call('forge.browser.acquire', { protocolVersion: 1, sessionAgentId: 'fixture', leaseId: 'hung-lease', leaseEpoch: 1, tabId: candidate.tabId, createIfNeeded: false })
        if (!acquired.result) throw new Error('acquire failed: ' + JSON.stringify(acquired.error))
        return acquired.result.tab.tabId
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('fixture tab did not enter inventory')`)

  // Wedge the renderer main thread, then disconnect so the extension is the only debugger client.
  const page = await devtools(pageTarget.webSocketDebuggerUrl)
  await page.send('Runtime.evaluate', { expression: 'setTimeout(() => { while (true) {} }, 0); 1' })
  page.close()
  await delay(500)

  const state = await inWorker(`
    const navigate = call('forge.browser.execute', { protocolVersion: 1, requestId: 'hung-navigate', leaseId: 'hung-lease', leaseEpoch: 1, tabId: ${tabId}, operation: 'navigate', input: { url: ${JSON.stringify(`${fixtureUrl}?next`)}, readiness: 'load', timeoutMs: 15000 }, deadlineAt: new Date(Date.now() + 15000).toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const setupStuck = globalThis.__forgeIsolatedFixtureDiagnostics().debuggerMetrics.attachments === 0
    const releaseStartedAt = Date.now()
    const release = await within(call('forge.browser.release', { protocolVersion: 1, leaseId: 'hung-lease', leaseEpoch: 1, reason: 'operation-failed' }), 8000)
    const releaseMs = Date.now() - releaseStartedAt
    const operation = await within(navigate, 2000)
    const diagnostics = globalThis.__forgeIsolatedFixtureDiagnostics()
    const reacquired = release === 'pending' ? 'pending' : await within(call('forge.browser.acquire', { protocolVersion: 1, sessionAgentId: 'fixture', leaseId: 'next-lease', leaseEpoch: 2, tabId: ${tabId}, createIfNeeded: false }), 5000)
    return {
      setupStuck,
      released: release !== 'pending' && release.result?.releasedTabIds?.[0] === ${tabId},
      releaseMs,
      operationSettled: operation !== 'pending' && operation.result?.ok === false,
      operationError: operation === 'pending' ? 'pending' : operation.result?.error?.code,
      activeAttachments: diagnostics.debuggerMetrics.activeAttachments,
      retainedAuthorities: diagnostics.authorities.length,
      reacquired: reacquired !== 'pending' && reacquired.result?.tab?.tabId === ${tabId},
    }`)
  worker.close()
  if (!state.setupStuck || !state.released || !state.operationSettled || state.activeAttachments !== 0 || state.retainedAuthorities !== 0 || !state.reacquired) {
    throw new Error(`hung-renderer release proof failed: ${JSON.stringify(state)}`)
  }
  evidence = { executable: path.basename(executable), version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(), ...state }
} finally {
  try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch { /* already stopped */ }
  await delay(500)
  await rm(profile, { recursive: true, force: true })
  server.closeAllConnections?.()
  server.close()
}
process.stdout.write(`${JSON.stringify(evidence)}\n`)
