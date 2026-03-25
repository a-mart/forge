import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(electronDir, '..', '..')
const stageDir = path.join(electronDir, '.stage')
const backendStageDir = path.join(stageDir, 'backend')
const uiStageDir = path.join(stageDir, 'ui')
const forgeResourcesDir = path.join(stageDir, 'forge-resources')
const pnpmCommand = 'pnpm'
const useShell = process.platform === 'win32'

const declarationSuffixes = ['.d.ts', '.d.mts', '.d.cts']
const declarationMapSuffixes = ['.d.ts.map', '.d.mts.map', '.d.cts.map']
const docsPrefixes = ['license', 'changelog', 'readme']

async function main() {
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })

  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/protocol', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/backend', 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/ui', 'build'])
  await run(pnpmCommand, ['--dir', electronDir, 'build'])
  await run(pnpmCommand, ['--dir', repoRoot, '--filter', '@forge/backend', 'deploy', '--prod', '--legacy', backendStageDir])
  await removeExternalWorkspaceLinks()
  await pruneNodeModules(path.join(backendStageDir, 'node_modules'))

  await stageRendererAssets()
  await stageBackendResources()

  await assertExists(path.join(backendStageDir, 'dist', 'index.js'), 'staged backend dist entry')
  await assertExists(path.join(uiStageDir, 'index.html'), 'staged renderer entry')
  await assertExists(path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins'), 'staged built-in skills')
}

async function removeExternalWorkspaceLinks() {
  await rm(path.join(backendStageDir, 'node_modules', '.pnpm', 'node_modules', '@forge', 'backend'), {
    force: true,
  })
}

function shouldPruneNodeModulesFile(fileName) {
  const normalizedFileName = fileName.toLowerCase()

  if (declarationMapSuffixes.some((suffix) => normalizedFileName.endsWith(suffix))) {
    return true
  }

  if (declarationSuffixes.some((suffix) => normalizedFileName.endsWith(suffix))) {
    return true
  }

  if (normalizedFileName.endsWith('.md')) {
    return true
  }

  if (normalizedFileName.endsWith('.ts') && !normalizedFileName.endsWith('.d.ts')) {
    return true
  }

  if (docsPrefixes.some((prefix) => normalizedFileName.startsWith(prefix))) {
    return true
  }

  return false
}

async function countFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return 0
  }

  let fileCount = 0
  const directoriesToVisit = [rootDir]

  while (directoriesToVisit.length > 0) {
    const currentDirectory = directoriesToVisit.pop()
    const directoryEntries = await readdir(currentDirectory, { withFileTypes: true })

    for (const entry of directoryEntries) {
      const entryPath = path.join(currentDirectory, entry.name)

      if (entry.isDirectory()) {
        directoriesToVisit.push(entryPath)
        continue
      }

      if (entry.isFile()) {
        fileCount += 1
      }
    }
  }

  return fileCount
}

async function pruneNodeModules(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) {
    return
  }

  const fileCountBeforePrune = await countFiles(nodeModulesDir)
  const directoriesToVisit = [nodeModulesDir]
  let removedFileCount = 0

  while (directoriesToVisit.length > 0) {
    const currentDirectory = directoriesToVisit.pop()
    const directoryEntries = await readdir(currentDirectory, { withFileTypes: true })

    for (const entry of directoryEntries) {
      const entryPath = path.join(currentDirectory, entry.name)

      if (entry.isDirectory()) {
        directoriesToVisit.push(entryPath)
        continue
      }

      if (entry.isFile() && shouldPruneNodeModulesFile(entry.name)) {
        await rm(entryPath, { force: true })
        removedFileCount += 1
      }
    }
  }

  const fileCountAfterPrune = await countFiles(nodeModulesDir)
  const effectiveRemovedCount = fileCountBeforePrune - fileCountAfterPrune

  console.log(
    `[electron/build-all] Pruned staged backend node_modules files: ${fileCountBeforePrune} -> ${fileCountAfterPrune} (${effectiveRemovedCount} removed, ${removedFileCount} delete operations)`
  )
}

async function stageRendererAssets() {
  await copyDirectory(path.join(repoRoot, 'apps', 'ui', '.output', 'public'), uiStageDir)

  const shellPath = path.join(uiStageDir, '_shell.html')
  if (existsSync(shellPath)) {
    await cp(shellPath, path.join(uiStageDir, 'index.html'))
  }
}

async function stageBackendResources() {
  await mkdir(forgeResourcesDir, { recursive: true })

  await writeFile(
    path.join(forgeResourcesDir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    'utf8',
  )

  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'archetypes'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'archetypes'),
  )
  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'operational'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'operational'),
  )
  await copyDirectory(
    path.join(repoRoot, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins'),
    path.join(forgeResourcesDir, 'apps', 'backend', 'src', 'swarm', 'skills', 'builtins'),
  )

  const repoSwarmDir = path.join(repoRoot, '.swarm')
  if (existsSync(repoSwarmDir)) {
    await copyDirectory(repoSwarmDir, path.join(forgeResourcesDir, '.swarm'))
  }
}

async function copyDirectory(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

async function assertExists(targetPath, label) {
  try {
    await stat(targetPath)
  } catch {
    throw new Error(`Missing ${label}: ${targetPath}`)
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
      shell: useShell,
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} ${args.join(' ')} failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
    })
  })
}

main().catch((error) => {
  console.error('[electron/build-all] Failed to assemble packaged app resources')
  console.error(error)
  process.exit(1)
})
