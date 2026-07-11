#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const lockText = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

const expectedVersion = '0.80.6'
const family = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
]
const expectedPatchFiles = new Map([
  ['@earendil-works/pi-ai@0.80.6', 'patches/@earendil-works__pi-ai@0.80.6.patch'],
  ['@earendil-works/pi-coding-agent@0.80.6', 'patches/@earendil-works__pi-coding-agent@0.80.6.patch'],
])
const oldScopeAllowlist = [/^@mariozechner\/clipboard(?:-|@)/]

function fail(message) {
  console.error(`[pi-package-identity] ${message}`)
  process.exit(1)
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function findInstalledManifest(name) {
  const directCandidates = [
    path.join(repoRoot, 'apps/backend/node_modules', ...name.split('/'), 'package.json'),
    path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json'),
  ]
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate
  }

  const pnpmDir = path.join(repoRoot, 'node_modules/.pnpm')
  const encoded = name.replace('/', '+')
  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith(`${encoded}@${expectedVersion}`)) continue
    const candidate = path.join(pnpmDir, entry, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(candidate)) return candidate
  }
  fail(`unable to locate installed manifest for ${name}`)
}

function lockPackageBlocks(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...lockText.matchAll(new RegExp(`^\\s{2}'${escaped}@([^']+)':`, 'gm'))].map((match) => match[1])
}

function lockIntegrity(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = lockText.match(new RegExp(`^\\s{2}'${escaped}@${expectedVersion}':\\n\\s{4}resolution: \\{integrity: ([^}]+)\\}`, 'm'))
  return match?.[1]
}

const installed = []
for (const name of family) {
  const manifestPath = findInstalledManifest(name)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const realpath = realpathSync(path.dirname(manifestPath))
  if (manifest.name !== name) fail(`resolved ${name} to manifest ${manifest.name}`)
  if (manifest.version !== expectedVersion) fail(`${name} installed version ${manifest.version}, expected ${expectedVersion}`)
  const blocks = lockPackageBlocks(name)
  if (!blocks.some((block) => block.startsWith(expectedVersion))) fail(`${name} missing ${expectedVersion} lock block`)
  const incompatible = blocks.filter((block) => !block.startsWith(expectedVersion))
  if (incompatible.length > 0) fail(`${name} has non-${expectedVersion} lock blocks: ${incompatible.join(', ')}`)
  const integrity = lockIntegrity(name)
  if (!integrity) fail(`${name} missing tarball integrity in lockfile`)
  installed.push({ name, version: manifest.version, realpath, integrity, lockBlocks: blocks })
}

const oldScopeMatches = [...lockText.matchAll(/@mariozechner\/[A-Za-z0-9._-]+(?:@|-)/g)].map((match) => match[0])
const unexpectedOldScope = [...new Set(oldScopeMatches)].filter(
  (entry) => !oldScopeAllowlist.some((allowed) => allowed.test(entry)),
)
if (unexpectedOldScope.length > 0) {
  fail(`unexpected old-scope Pi packages in lockfile: ${unexpectedOldScope.join(', ')}`)
}

const patchedDependencies = rootManifest.pnpm?.patchedDependencies ?? {}
const patches = []
for (const [key, patchFile] of expectedPatchFiles) {
  if (patchedDependencies[key] !== patchFile) fail(`patchedDependencies[${key}] is ${patchedDependencies[key] ?? '<missing>'}`)
  const absolutePatch = path.join(repoRoot, patchFile)
  if (!existsSync(absolutePatch)) fail(`patch file missing: ${patchFile}`)
  const patchHash = sha256File(absolutePatch)
  const lockBlock = lockPackageBlocks(key.replace(/@0\.80\.6$/, ''))
  const patchedInstances = lockBlock.filter((block) => block.includes('patch_hash='))
  if (patchedInstances.length === 0) fail(`${key} has no pnpm patched lock instance`)
  patches.push({ key, patchFile, sha256: patchHash, patchedInstances })
}

const result = {
  ok: true,
  expectedVersion,
  installed,
  patches,
  oldScopeAllowlist: ['@mariozechner/clipboard*'],
}

console.log(JSON.stringify(result, null, 2))
