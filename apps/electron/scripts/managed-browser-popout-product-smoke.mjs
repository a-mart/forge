import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const electronDir = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(electronDir, 'package.json'))
const electron = require('electron')
const root = await mkdtemp(path.join(os.tmpdir(), 'forge-browser-popout-product-'))
try {
  const env = { ...process.env, FORGE_BROWSER_POPOUT_FIXTURE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [path.join(electronDir, 'dist', 'managed-browser-popout-fixture-main.js')], { cwd: electronDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() }); child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Managed Browser production pop-out fixture timed out')) }, 45_000)
    child.once('error', reject); child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
  })
  const prefix = 'FORGE_BROWSER_POPOUT_PRODUCT_RESULT='
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix))
  if (code !== 0 || !line) throw new Error(`Managed Browser production pop-out fixture failed (code=${code})\n${stdout}\n${stderr}`)
  const report = JSON.parse(line.slice(prefix.length))
  if (report.passed !== true) throw new Error(`Managed Browser production pop-out fixture returned an invalid report: ${JSON.stringify(report)}`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally { await rm(root, { recursive: true, force: true }) }
