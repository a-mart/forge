import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(scriptDir, 'secure-vault-async-fixture.cjs')
const userDataDir = await mkdtemp(
  path.join(tmpdir(), 'forge-secure-vault-async-'),
)

try {
  const result = await runElectron(fixturePath, userDataDir)
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error('Electron safeStorage smoke returned an invalid result')
  }
  if (
    result.code !== 0
    || parsed?.ok !== true
    || parsed?.syncToAsync !== true
    || parsed?.asyncToSync !== true
  ) {
    throw new Error(
      `Electron safeStorage smoke failed with code ${result.code}: `
      + String(parsed?.code ?? 'interop-failed'),
    )
  }
  process.stdout.write(
    'Electron safeStorage sync/async ciphertext interoperability passed.\n',
  )
} finally {
  await rm(userDataDir, { recursive: true, force: true })
}

function runElectron(fixture, userData) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, `--user-data-dir=${userData}`], {
      cwd: scriptDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    let stderrBytes = 0
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('Electron safeStorage smoke timed out'))
    }, 30_000)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > 1024 * 1024) child.kill()
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
      })
    })
  })
}
