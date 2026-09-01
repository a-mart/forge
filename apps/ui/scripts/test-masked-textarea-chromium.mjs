import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronRoot = path.resolve(uiRoot, '../electron')
const require = createRequire(path.join(electronRoot, 'package.json'))
const electron = require('electron')
const fixtureMain = path.join(uiRoot, 'scripts', 'masked-textarea-chromium-main.cjs')
const fixturePath = '/masked-textarea.chromium.fixture.html'

const server = await createServer({
  root: uiRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})

try {
  await server.listen()
  const origin = server.resolvedUrls?.local[0]
  if (!origin) throw new Error('Vite did not provide a local URL')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [fixtureMain, new URL(fixturePath, origin).toString()], {
    cwd: uiRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.resume()

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Chromium masked textarea regression timed out'))
    }, 30_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  const prefix = 'FORGE_MASKED_TEXTAREA_AX_RESULT='
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(prefix))
  if (exitCode !== 0 || !resultLine) {
    throw new Error('Chromium masked textarea regression did not return a result')
  }

  const report = JSON.parse(resultLine.slice(prefix.length))
  if (report.passed !== true) throw new Error('Chromium masked textarea regression failed')
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  await Promise.race([
    server.close(),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ])
}

// TanStack Start's development plugins leave timers alive after the fixture server closes.
process.exit(0)
