import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { stageBrowserRuntime } from './build-all.mjs'

const electronDir = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const require = createRequire(path.join(electronDir, 'package.json'))
const asar = require('@electron/asar')
const output = await mkdtemp(path.join(os.tmpdir(), 'forge-browser-package-'))
const configPath = path.join(electronDir, '.browser-package-smoke.json')
try {
  await stageBrowserRuntime()
  const config = {
    appId: 'com.forge.browser-host-smoke',
    productName: 'Forge Browser Host Smoke',
    directories: { app: electronDir, output, buildResources: path.join(electronDir, 'build') },
    files: ['dist/**/*', '!dist/browser-fixture-smoke-main*', 'node_modules/playwright-core/**/*', 'package.json'],
    extraResources: [{ from: path.join(electronDir, '.stage', 'browser-runtime'), to: 'browser-runtime', filter: ['**/*'] }],
    mac: { target: ['dir'], identity: null },
    linux: { target: ['dir'] },
    win: { target: ['dir'] },
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await run('pnpm', ['exec', 'electron-builder', '--dir', '--config', configPath, '--publish', 'never'])

  const resources = await findResourcesDirectory(output)
  const archivePath = path.join(resources, 'app.asar')
  if (!existsSync(archivePath)) throw new Error(`Packaged browser smoke did not create ${archivePath}`)
  const archiveEntries = asar.listPackage(archivePath)
  for (const entry of ['dist/main.js', 'dist/preload.js', 'dist/guest-preload.js']) {
    if (!archiveEntries.some((candidate) => candidate.replace(/^\//, '') === entry)) throw new Error(`Packaged app.asar is missing ${entry}`)
  }
  const stagedCore = path.join(resources, 'browser-runtime', 'playwright-core', 'lib', 'coreBundle.js')
  const stagedLicense = path.join(resources, 'browser-runtime', 'playwright-core', 'LICENSE')
  const stagedNotice = path.join(resources, 'browser-runtime', 'THIRD_PARTY_NOTICES.md')
  const rootNotice = path.join(repoRoot, 'THIRD_PARTY_NOTICES.md')
  for (const [file, label] of [[stagedCore, 'Playwright coreBundle.js'], [stagedLicense, 'Playwright license'], [stagedNotice, 'browser notice'], [rootNotice, 'root browser notice']]) {
    if (!existsSync(file)) throw new Error(`Packaged resources are missing ${label}: ${file}`)
  }
  const bundle = await readFile(stagedCore, 'utf8')
  if (!bundle.includes('source3 = ')) throw new Error('Packaged Playwright bundle does not contain the validated locator marker')
  const rootNoticeBytes = await readFile(rootNotice)
  const stagedNoticeBytes = await readFile(stagedNotice)
  if (!rootNoticeBytes.equals(stagedNoticeBytes)) {
    throw new Error('Packaged browser-runtime/THIRD_PARTY_NOTICES.md is not byte-identical to the maintained root THIRD_PARTY_NOTICES.md')
  }
  const noticeSha256 = createHash('sha256').update(stagedNoticeBytes).digest('hex')
  process.stdout.write(`${JSON.stringify({ passed: true, resources, archiveEntries: ['dist/main.js', 'dist/preload.js', 'dist/guest-preload.js'], playwrightCoreBundle: stagedCore, notice: stagedNotice, noticeSha256 }, null, 2)}\n`)
} finally {
  await rm(configPath, { force: true })
  await rm(output, { recursive: true, force: true })
}

async function findResourcesDirectory(root) {
  const candidates = process.platform === 'darwin'
    ? [path.join(root, 'mac-arm64', 'Forge Browser Host Smoke.app', 'Contents', 'Resources'), path.join(root, 'mac', 'Forge Browser Host Smoke.app', 'Contents', 'Resources')]
    : process.platform === 'win32'
      ? [path.join(root, 'win-unpacked', 'resources')]
      : [path.join(root, 'linux-unpacked', 'resources')]
  const found = candidates.find(existsSync)
  if (!found) throw new Error(`Unable to find packaged resources below ${root}`)
  return found
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: electronDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)))
  })
}
