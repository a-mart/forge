import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGET_VERSIONS = Object.freeze({
  electron: '43.2.0',
  node: '24.18.0',
  chrome: '150.0.7871.129',
  v8: '15.0.1240245-electron.0',
})

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const electronRequire = createRequire(path.join(electronDir, 'package.json'))

export async function verifyElectronRuntime() {
  const packageVersion = electronRequire('electron/package.json').version
  assertVersion('installed package', packageVersion, TARGET_VERSIONS.electron)

  // Electron 42+ downloads the platform binary lazily. Invoking its CLI here makes
  // that network/materialization gate deterministic and early instead of deferring
  // it until native preparation or electron-builder packaging.
  const cliPath = electronRequire.resolve('electron/cli.js')
  const cliEnvironment = { ...process.env }
  delete cliEnvironment.ELECTRON_RUN_AS_NODE
  const cliOutput = (await run(process.execPath, [cliPath, '--version'], {
    cwd: electronDir,
    env: cliEnvironment,
  })).stdout.trim()
  const cliVersion = cliOutput.split(/\r?\n/).at(-1)?.replace(/^v/, '')
  assertVersion('CLI', cliVersion, TARGET_VERSIONS.electron)

  const electronExecutable = electronRequire('electron')
  const result = await run(electronExecutable, ['-p', 'JSON.stringify(process.versions)'], {
    cwd: electronDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const runtimeVersions = JSON.parse(result.stdout.trim())
  for (const [component, expectedVersion] of Object.entries(TARGET_VERSIONS)) {
    assertVersion(`embedded ${component}`, runtimeVersions[component], expectedVersion)
  }

  console.log(
    `[electron/runtime] Verified Electron ${runtimeVersions.electron} (Node ${runtimeVersions.node}, Chromium ${runtimeVersions.chrome}, V8 ${runtimeVersions.v8})`,
  )
  return runtimeVersions
}

function assertVersion(label, actualVersion, expectedVersion) {
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected Electron ${label} version ${expectedVersion}, found ${String(actualVersion)}`)
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `${command} exited with code=${String(code)} signal=${String(signal)}${stderr ? `: ${stderr.trim()}` : ''}`,
        ),
      )
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyElectronRuntime().catch((error) => {
    console.error(`[electron/runtime] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
