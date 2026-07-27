import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_EXTENSION_ID } from './verify-identity.mjs'

if (process.env.FORGE_RUN_ISOLATED_CHROME !== '1') {
  throw new Error('isolated Chrome fixture is opt-in; set FORGE_RUN_ISOLATED_CHROME=1')
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionRoot = path.resolve(process.argv[2] ?? path.join(sourceRoot, 'dist/extension'))
const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'))
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
const args = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-search-engine-choice-screen', '--disable-sync',
  '--metrics-recording-only', '--password-store=basic', '--use-mock-keychain',
  '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`, 'about:blank',
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

async function workerTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) return undefined
  const targets = await response.json()
  return targets.find((target) => target.type === 'service_worker' && target.url === `chrome-extension://${EXPECTED_EXTENSION_ID}/shell/service-worker-bootstrap.js`)
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
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  try {
    await send('Runtime.enable')
    const evaluation = await send('Runtime.evaluate', {
      expression: `new Promise(resolve => {
        const deadline = Date.now() + 10_000;
        const inspect = async () => {
          const [stored, alarm] = await Promise.all([
            chrome.storage.local.get('forge.externalChrome.instanceId.v1'),
            chrome.alarms.get('forge.externalChrome.heartbeat.v1')
          ]);
          const state = {
            manifestName: chrome.runtime.getManifest().name,
            extensionId: chrome.runtime.id,
            instanceReady: typeof stored['forge.externalChrome.instanceId.v1'] === 'string',
            heartbeatReady: alarm?.name === 'forge.externalChrome.heartbeat.v1',
            bootState: globalThis.__forgeServiceWorkerBootState ?? null,
            workerLocation: globalThis.location.href
          };
          if (state.bootState?.state === 'ready' || Date.now() >= deadline) resolve(state);
          else setTimeout(inspect, 50);
        };
        void inspect();
      })`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (evaluation.exceptionDetails) throw new Error(`worker evaluation failed: ${evaluation.exceptionDetails.text}`)
    return { state: evaluation.result?.value, runtimeErrors }
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
  const inspected = await inspectWorker(target.webSocketDebuggerUrl)
  const state = inspected.state
  if (state?.manifestName !== 'Forge' || state?.extensionId !== EXPECTED_EXTENSION_ID) throw new Error('worker reported an unexpected Forge identity')
  if (state?.instanceReady !== true || state?.heartbeatReady !== true || state?.bootState?.state !== 'ready') {
    throw new Error(`Forge payload did not reach ready state: ${JSON.stringify(state)}`)
  }
  if (state.workerLocation !== target.url) throw new Error('worker target URL and runtime location disagree')
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
    nativeHostAbsent: /native messaging host.*not found|specified native messaging host not found/iu.test(stderr),
    importScriptsBootError: false,
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
}

let profileRemoved = false
try { await access(profile) } catch { profileRemoved = true }
if (!profileRemoved) throw new Error('isolated Chrome profile cleanup failed')
if (child !== undefined && process.platform !== 'win32' && processGroupAlive(child.pid)) throw new Error('isolated Chrome process group is still running')
if (evidence === undefined) throw new Error(`isolated Chrome verification failed${stderr ? `: ${stderr.slice(-1_024)}` : ''}`)
process.stdout.write(`${JSON.stringify({ ...evidence, processStopped: true, profileRemoved: true })}\n`)
