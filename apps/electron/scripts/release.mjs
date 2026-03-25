import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { spawnSync } from 'node:child_process'

const VALID_BUMPS = new Set(['patch', 'minor', 'major'])

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const electronDir = path.resolve(scriptDir, '..')
const packageJsonPath = path.join(electronDir, 'package.json')

async function main() {
  const packageJsonRaw = await readFile(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(packageJsonRaw)
  const currentVersion = packageJson.version

  if (!isSemver(currentVersion)) {
    throw new Error(`Current version is not semver: ${currentVersion}`)
  }

  const arg = process.argv[2]
  const requested = arg ? arg.trim() : await promptForVersionInput(currentVersion)
  const nextVersion = resolveNextVersion(currentVersion, requested)

  if (nextVersion === currentVersion) {
    throw new Error(`Version is already ${currentVersion}`)
  }

  packageJson.version = nextVersion
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')

  runGit(['add', packageJsonPath])
  runGit(['commit', '-m', `chore(electron): release v${nextVersion}`])
  runGit(['tag', `v${nextVersion}`])
  runGit(['push', 'origin', 'HEAD'])
  runGit(['push', 'origin', `v${nextVersion}`])

  console.log(`Released Electron version v${nextVersion}`)
}

function resolveNextVersion(currentVersion, requested) {
  if (VALID_BUMPS.has(requested)) {
    return bumpSemver(currentVersion, requested)
  }

  if (isSemver(requested)) {
    return requested
  }

  throw new Error(`Invalid version input: ${requested}. Use patch, minor, major, or x.y.z`)
}

function bumpSemver(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number)

  if (bump === 'major') {
    return `${major + 1}.0.0`
  }

  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`
  }

  return `${major}.${minor}.${patch + 1}`
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(value)
}

async function promptForVersionInput(currentVersion) {
  const rl = createInterface({ input, output })

  try {
    const answer = await rl.question(
      `Current Electron version is ${currentVersion}. Enter bump type (patch/minor/major) or explicit version [patch]: `,
    )

    const trimmed = answer.trim()
    return trimmed.length > 0 ? trimmed : 'patch'
  } finally {
    rl.close()
  }
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: electronDir,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
}

main().catch((error) => {
  console.error('[electron/release] Failed to create release commit/tag')
  console.error(error)
  process.exit(1)
})
