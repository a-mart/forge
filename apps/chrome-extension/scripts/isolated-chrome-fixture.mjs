import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXPECTED_EXTENSION_ID } from './verify-identity.mjs'

if (process.env.FORGE_RUN_ISOLATED_CHROME !== '1') {
  throw new Error('isolated Chrome fixture is opt-in; set FORGE_RUN_ISOLATED_CHROME=1')
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionRoot = path.resolve(process.argv[2] ?? path.join(sourceRoot, 'dist/extension'))
const candidates = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? [path.join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe')]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const executable = candidates.find((candidate) => spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0)
if (executable === undefined) throw new Error('no qualified Chrome or Chromium executable is available')
const version = spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim()
const profile = await mkdtemp(path.join(os.tmpdir(), 'forge-external-chrome-fixture-'))
let child

async function containsIdentity(directory, depth = 0) {
  if (depth > 5) return false
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (await containsIdentity(absolute, depth + 1)) return true
    } else if (entry.isFile() && entry.name !== 'LOCK' && entry.name !== 'SingletonLock') {
      try {
        const content = await readFile(absolute, 'utf8')
        if (content.includes(EXPECTED_EXTENSION_ID)) return true
      } catch { /* binary or transient Chrome file */ }
    }
  }
  return false
}

try {
  child = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`,
    'data:text/html,<title>Forge isolated extension fixture</title>',
  ], { stdio: 'ignore', detached: process.platform !== 'win32' })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 3_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error(`isolated Chrome exited ${code}`)) } })
  })
  const identityObserved = await containsIdentity(profile)
  if (!identityObserved) throw new Error('isolated Chrome profile did not record the pinned extension identity')
  process.stdout.write(`${JSON.stringify({ version, extensionId: EXPECTED_EXTENSION_ID, isolatedProfile: true, cleaned: true })}\n`)
} finally {
  if (child !== undefined && child.exitCode === null) {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2_000) })
    if (child.exitCode === null && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  await rm(profile, { recursive: true, force: true })
}
