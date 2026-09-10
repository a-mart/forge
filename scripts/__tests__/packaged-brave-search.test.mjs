import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectRuntimePackageClosure, stageBraveSearchDependencies } from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const skillRelative = 'apps/backend/src/swarm/skills/builtins/brave-search'
const sourceSkill = path.join(repoRoot, skillRelative)
const html = '<html><head><title>Packaged article fixture</title></head><body><article>' +
  '<h1>Packaged article fixture</h1>' +
  Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}. This deterministic article checks packaged content extraction without contacting a remote service. The library should preserve meaningful content and readable formatting for this local fixture.</p>`).join('') +
  '<p><a href="https://bücher.example/article">Example reference</a></p>' +
  '<p><del>obsolete text</del></p></article></body></html>'
const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
let root
let stagedSkill

function runScript(script, args = []) {
  // No inherited module search overrides, API keys, preload hooks, or profiles.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP'].includes(key.toUpperCase()),
  ))
  const result = spawnSync(process.execPath, ['--no-global-search-paths', path.join(stagedSkill, script), ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

describe('packaged Brave Search dependency closure', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'forge-brave-stage-')))
    expect(root.startsWith(`${repoRoot}${path.sep}`)).toBe(false)
    // Fail rather than let an ambient ancestor node_modules mask an incomplete stage.
    for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
      await expect(readdir(path.join(ancestor, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (ancestor === path.dirname(ancestor)) break
    }
    stagedSkill = path.join(root, 'forge-resources', skillRelative)
    await cp(sourceSkill, stagedSkill, {
      recursive: true,
      filter: (source) => !path.relative(sourceSkill, source).split(path.sep).includes('node_modules'),
    })
    await stageBraveSearchDependencies(stagedSkill)
  }, 30_000)

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('resolves all manifest roots locally and retains the npm punycode package', async () => {
    const manifest = JSON.parse(await readFile(path.join(sourceSkill, 'package.json'), 'utf8'))
    const stagedRequire = createRequire(path.join(stagedSkill, 'content.js'))
    for (const name of [...Object.keys(manifest.dependencies), 'punycode/']) {
      const entry = await realpath(stagedRequire.resolve(name))
      expect(entry.startsWith(`${stagedSkill}${path.sep}node_modules${path.sep}`), name).toBe(true)
    }
    for (const script of ['content.js', 'search.js', 'tls-env.js']) {
      expect(await readFile(path.join(stagedSkill, script), 'utf8')).toBe(await readFile(path.join(sourceSkill, script), 'utf8'))
    }
  })

  it('runs the actual content CLI on fixture HTML, including Unicode links and GFM', () => {
    const result = runScript('content.js', [dataUrl])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('# Packaged article fixture')
    expect(result.stdout).toContain('Paragraph 7')
    expect(result.stdout).toContain('https://xn--bcher-kva.example/article')
    expect(result.stdout).toContain('~obsolete text~')
  })

  it('preserves the full manifest closure, including nested dependency versions', async () => {
    const manifest = JSON.parse(await readFile(path.join(sourceSkill, 'package.json'), 'utf8'))
    const roots = Object.keys(manifest.dependencies).map((packageName) => ({ packageName, optional: false }))
    const source = await collectRuntimePackageClosure(roots, path.join(sourceSkill, 'package.json'))
    const staged = await collectRuntimePackageClosure(roots, path.join(stagedSkill, 'package.json'))
    const inventory = (closure) => [...closure.hoisted, ...closure.nested].map((pkg) =>
      [pkg.name, pkg.manifest.version, pkg.nestUnderPackageName ?? null],
    ).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    expect(inventory(staged)).toEqual(inventory(source))
    for (const pkg of [...staged.hoisted, ...staged.nested]) {
      expect((await realpath(pkg.packageRoot)).startsWith(`${stagedSkill}${path.sep}node_modules${path.sep}`), pkg.name).toBe(true)
    }
  })

  it('reaches search usage and missing-key diagnostics without an API call', () => {
    const usage = runScript('search.js')
    expect(usage.status, usage.stderr).toBe(1)
    expect(usage.stdout).toContain('Usage: search.js')
    expect(usage.stderr).toBe('')
    const missingKey = runScript('search.js', ['fixture query'])
    expect(missingKey.status).toBe(1)
    expect(missingKey.stderr).toContain('BRAVE_API_KEY environment variable is required')
    expect(missingKey.stderr).not.toContain('MODULE_NOT_FOUND')
  })

  it.each([
    ['@mozilla/readability', /@mozilla\/readability/],
    ['punycode', /punycode/],
    ['jsdom/lib/jsdom/browser/default-stylesheet.css', /default-stylesheet\.css/],
    ['css-tree/data/patch.json', /patch\.json/],
  ])('fails closed when required package or relative asset %s is missing', async (relative, diagnostic) => {
    const target = path.join(stagedSkill, 'node_modules', relative)
    const backup = path.join(root, 'removed-asset')
    await rename(target, backup)
    try {
      const result = runScript('content.js', [dataUrl])
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(diagnostic)
      expect(result.stdout).not.toContain('Paragraph 7')
    } finally {
      await rename(backup, target)
    }
  })

  it('rejects a missing required manifest dependency during staging', async () => {
    const fixture = path.join(root, 'missing-source')
    await mkdir(fixture)
    const manifestPath = path.join(fixture, 'package.json')
    await writeFile(manifestPath, JSON.stringify({ dependencies: { 'forge-brave-missing-dependency': '1.0.0' } }))
    await expect(stageBraveSearchDependencies(path.join(root, 'missing-stage'), manifestPath))
      .rejects.toThrow('Failed to resolve runtime package "forge-brave-missing-dependency"')
  })
})
