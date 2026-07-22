import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const electronDir = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(electronDir, 'package.json'))
const electron = require('electron')
const root = await mkdtemp(path.join(os.tmpdir(), 'forge-browser-fixture-'))
try {
  const env = { ...process.env, FORGE_BROWSER_FIXTURE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [path.join(electronDir, 'dist', 'browser-fixture-smoke-main.js')], {
    cwd: electronDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Electron browser fixture timed out')) }, 40_000)
    child.once('error', reject)
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
  })
  const reportLine = stdout.split(/\r?\n/).find((line) => line.startsWith('FORGE_BROWSER_FIXTURE_RESULT='))
  if (code !== 0 || !reportLine) throw new Error(`Electron browser fixture failed (code=${code})\n${stdout}\n${stderr}`)
  const report = JSON.parse(reportLine.slice('FORGE_BROWSER_FIXTURE_RESULT='.length))
  if (report.passed !== true || !Array.isArray(report.operations) || report.operations.length !== 13) throw new Error(`Electron browser fixture returned an invalid report: ${JSON.stringify(report)}`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
