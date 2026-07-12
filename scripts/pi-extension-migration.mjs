#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SUPPORTED_REWRITES = new Map([
  ['@mariozechner/pi-ai', '@earendil-works/pi-ai/compat'],
  ['@mariozechner/pi-ai/compat', '@earendil-works/pi-ai/compat'],
  ['@mariozechner/pi-ai/oauth', '@earendil-works/pi-ai/oauth'],
  ['@mariozechner/pi-coding-agent', '@earendil-works/pi-coding-agent'],
  ['@mariozechner/pi-agent-core', '@earendil-works/pi-agent-core'],
  ['@mariozechner/pi-tui', '@earendil-works/pi-tui'],
])
const LEGACY_SPECIFIER_PATTERN = /(['"])(@mariozechner\/pi-(?:ai|coding-agent|agent-core|tui)(?:\/[A-Za-z0-9._/-]+)?)(\1)/g
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'])

function usage() {
  console.error('Usage: node scripts/pi-extension-migration.mjs [--write] <extension-dir> [...extension-dir]')
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const roots = args.filter((arg) => arg !== '--write')
if (roots.length === 0) {
  usage()
  process.exit(2)
}

const findings = []
for (const root of roots) {
  await scanPath(path.resolve(root))
}

console.log(JSON.stringify({ ok: findings.every((finding) => finding.supported), write, findings }, null, 2))
if (findings.some((finding) => !finding.supported)) process.exit(1)

async function scanPath(target) {
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOTDIR') {
      await scanFile(target)
      return
    }
    throw error
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const child = path.join(target, entry.name)
    if (entry.isDirectory()) await scanPath(child)
    else if (entry.isFile()) await scanFile(child)
  }
}

async function scanFile(file) {
  if (!EXTENSIONS.has(path.extname(file))) return
  const original = await readFile(file, 'utf8')
  let changed = original
  for (const match of original.matchAll(LEGACY_SPECIFIER_PATTERN)) {
    const specifier = match[2]
    const replacement = SUPPORTED_REWRITES.get(specifier)
    findings.push({
      file,
      specifier,
      supported: Boolean(replacement),
      replacement: replacement ?? null,
      diagnostic: replacement
        ? `Rewrite ${specifier} to ${replacement}; Forge does not ship @mariozechner/pi-* shims.`
        : `Unsupported legacy Pi extension import ${specifier}; migrate to an explicit @earendil-works/* public export. Forge does not ship shims.`,
    })
    if (replacement) {
      changed = changed.replaceAll(`${match[1]}${specifier}${match[3]}`, `${match[1]}${replacement}${match[3]}`)
    }
  }
  if (write && changed !== original) await writeFile(file, changed, 'utf8')
}
