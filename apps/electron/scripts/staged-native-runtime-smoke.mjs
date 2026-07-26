import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STAGED_ELECTRON_NATIVE_PACKAGES = Object.freeze([
  'better-sqlite3',
  'sqlite3',
  'node-pty',
  'sharp',
  'koffi',
])

export function assertResolvedInsideStage(resolvedEntry, stagedNodeModulesDir, packageName) {
  const stageRoot = realpathSync(stagedNodeModulesDir)
  const resolvedRealpath = realpathSync(resolvedEntry)
  const stagePrefix = `${stageRoot}${path.sep}`
  if (resolvedRealpath !== stageRoot && !resolvedRealpath.startsWith(stagePrefix)) {
    throw new Error(`${packageName} resolved outside staged node_modules: ${resolvedRealpath}`)
  }
  return resolvedRealpath
}

export async function runStagedNativeRuntimeSmoke(stagedNodeModulesDir) {
  const stagedRequire = createRequire(path.join(stagedNodeModulesDir, '..', 'package.json'))
  const loaded = new Map()

  for (const packageName of STAGED_ELECTRON_NATIVE_PACKAGES) {
    const resolvedEntry = stagedRequire.resolve(packageName)
    assertResolvedInsideStage(resolvedEntry, stagedNodeModulesDir, packageName)
    loaded.set(packageName, stagedRequire(resolvedEntry))
  }

  const Database = loaded.get('better-sqlite3')
  const database = new Database(':memory:')
  const row = database.prepare('SELECT 1 AS value').get()
  database.close()
  if (row?.value !== 1) throw new Error('better-sqlite3 returned an unexpected query result')

  const sqlite3 = loaded.get('sqlite3')
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (openError) => {
      if (openError) {
        reject(openError)
        return
      }
      db.get('SELECT 1 AS value', (queryError, queryRow) => {
        if (queryError || queryRow?.value !== 1) {
          db.close(() => reject(queryError ?? new Error('sqlite3 returned an unexpected query result')))
          return
        }
        db.close((closeError) => closeError ? reject(closeError) : resolve())
      })
    })
  })

  const pty = loaded.get('node-pty')
  await new Promise((resolve, reject) => {
    const child = pty.spawn(process.execPath, ['-e', 'process.stdout.write("forge-pty-ok")'], {
      cols: 80,
      rows: 24,
      cwd: path.dirname(stagedNodeModulesDir),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('node-pty smoke timed out'))
    }, 10_000)
    child.onData((chunk) => { output += chunk })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode !== 0 || !output.includes('forge-pty-ok')) {
        reject(new Error(`node-pty smoke failed with exitCode=${String(exitCode)} output=${JSON.stringify(output)}`))
        return
      }
      resolve()
    })
  })

  const sharp = loaded.get('sharp')
  const image = sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
  const png = await image.png().toBuffer()
  const metadata = await sharp(png).metadata()
  if (metadata.width !== 2 || metadata.height !== 2 || metadata.format !== 'png') {
    throw new Error(`sharp returned unexpected metadata: ${JSON.stringify(metadata)}`)
  }

  const koffi = loaded.get('koffi')
  const pair = koffi.struct('ForgeNativeSmokePair', { left: 'int', right: 'int' })
  if (koffi.sizeof(pair) < 8) throw new Error('koffi returned an unexpected struct size')

  return {
    electron: process.versions.electron,
    node: process.versions.node,
    modules: STAGED_ELECTRON_NATIVE_PACKAGES,
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const stagedNodeModulesDir = process.env.FORGE_STAGED_NODE_MODULES
  if (!stagedNodeModulesDir) {
    console.error('[electron/native-smoke] FORGE_STAGED_NODE_MODULES is required')
    process.exitCode = 1
  } else {
    runStagedNativeRuntimeSmoke(stagedNodeModulesDir)
      .then((report) => console.log(`[electron/native-smoke] ${JSON.stringify(report)}`))
      .catch((error) => {
        console.error(`[electron/native-smoke] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        process.exitCode = 1
      })
  }
}
