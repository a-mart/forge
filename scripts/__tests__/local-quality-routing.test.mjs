import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classify,
  isDockerConfigRelated,
  selectChecks,
} from '../local-quality.mjs'

const changed = (...paths) => paths.map((path) => ({ path, sources: ['test'] }))
const checkIds = (tier, ...paths) => selectChecks(tier, changed(...paths)).checks.map((check) => check.id)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const backendRoot = path.join(repoRoot, 'apps', 'backend')

const backendScriptTestCommand = (file) => [
  pnpm,
  ['exec', 'vitest', 'run', path.join('..', '..', 'scripts', '__tests__', file)],
  backendRoot,
]

describe('local quality routing', () => {
  it.each([
    ['apps/electron/src/main.ts', 'electron'],
    ['apps/chrome-extension/src/runtime/selector.ts', 'chrome-extension'],
    ['apps/native-messaging-host/src/transport.ts', 'native-messaging-host'],
    ['apps/stream-deck/src/plugin.ts', 'stream-deck'],
  ])('routes %s through its workspace checks', (file, area) => {
    const ids = checkIds('changed', file)

    expect([...classify(file).areas]).toContain(area)
    expect(ids).toContain('lint:changed-workspaces')
    expect(ids).toContain(`typecheck:${area}`)
    expect(ids).toContain(`test:${area}`)
  })

  it('routes changed tests from every supported workspace and root scripts in quick mode', () => {
    const selection = selectChecks('quick', changed(
      'apps/backend/src/test/stats-service-refresh-hook.test.ts',
      'apps/ui/src/lib/reasoning-level-labels.test.ts',
      'apps/electron/src/__tests__/deep-link.test.ts',
      'apps/chrome-extension/tests/selector.test.ts',
      'apps/native-messaging-host/tests/framing.test.ts',
      'apps/stream-deck/src/artwork.test.ts',
      'apps/skill-share-worker/src/index.test.ts',
      'packages/protocol/src/__tests__/choices.test.ts',
      'packages/cli/src/commands/parser.test.ts',
      'scripts/__tests__/electron-dev-routing.test.mjs',
    ))
    const ids = selection.checks.map((check) => check.id)

    expect(ids).toEqual(expect.arrayContaining([
      'test:changed:apps/backend',
      'test:changed:apps/ui',
      'test:changed:apps/electron',
      'test:changed:apps/chrome-extension',
      'test:changed:apps/native-messaging-host',
      'test:changed:apps/stream-deck',
      'test:changed:apps/skill-share-worker',
      'test:changed:packages/protocol',
      'test:changed:packages/cli',
    ]))
    expect(ids.filter((id) => id.startsWith('test:changed:'))).toHaveLength(9)

    expect(selection.checks.find((check) => check.id === 'test:changed:apps/backend')?.command).toEqual([
      pnpm,
      [
        'exec',
        'vitest',
        'run',
        path.join('src', 'test', 'stats-service-refresh-hook.test.ts'),
        path.join('..', '..', 'scripts', '__tests__', 'electron-dev-routing.test.mjs'),
      ],
      backendRoot,
    ])
  })

  it('does not route helpers, fixtures, or documentation through Vitest', () => {
    const ids = checkIds(
      'quick',
      'apps/backend/src/swarm/__tests__/helpers/pi-0711-rollback-runner.ts',
      'apps/chrome-extension/tests/fakes.ts',
      'apps/native-messaging-host/tests/README.md',
      'scripts/__tests__/fixtures/pi-extension-migration/README.md',
      'scripts/__tests__/fixtures/pi-extension-migration/legacy-supported.ts',
    )

    expect(ids.filter((id) => id.startsWith('test:changed:'))).toEqual([])
  })

  it('routes the Node runtime pin broadly and runs its exact preflight in quick mode', () => {
    const quick = selectChecks('quick', changed('.nvmrc'))
    const changedTier = selectChecks('changed', changed('.nvmrc'))

    expect(quick.checks.find((check) => check.id === 'test:packaged-runtime-preflight')?.command).toEqual(
      backendScriptTestCommand('packaged-runtime-preflight.test.mjs'),
    )
    expect(quick.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'typecheck:backend',
      'typecheck:electron',
      'typecheck:native-messaging-host',
    ]))
    expect(changedTier.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'lint',
      'test:backend',
      'test:electron',
    ]))
    expect(changedTier.failureHints.join('\n')).toContain('root config changed')
  })

  it.each(['quick', 'changed'])('runs the exact browser attribution gate for notice changes in %s mode', (tier) => {
    const selection = selectChecks(tier, changed('THIRD_PARTY_NOTICES.md'))

    expect(selection.checks.find((check) => check.id === 'test:browser-third-party-notices')?.command).toEqual(
      backendScriptTestCommand('browser-third-party-notices.test.mjs'),
    )
  })

  it.each([
    'apps/electron/src/browser/managed-electron-target-adapter.ts',
    'apps/electron/scripts/build-all.mjs',
    'packages/protocol/src/browser-automation.ts',
  ])('runs browser attribution validation for related quick changes to %s', (file) => {
    expect(checkIds('quick', file)).toContain('test:browser-third-party-notices')
  })

  it.each([
    'Dockerfile',
    'docker-compose.yml',
    '.dockerignore',
    'scripts/secure-sessions-e2e/Dockerfile',
    'scripts/verify-dockerignore-sensitive-context.mjs',
  ])('runs build-context verification and broad checks for %s', (file) => {
    const selection = selectChecks('changed', changed(file))
    const ids = selection.checks.map((check) => check.id)

    expect(isDockerConfigRelated(file)).toBe(true)
    expect(ids).toContain('verify:dockerignore')
    expect(ids).toContain('lint')
    expect(ids).toContain('typecheck:electron')
    expect(ids).toContain('test:chrome-extension')
    expect(selection.failureHints.join('\n')).toContain('Docker config changed')
  })

  it.each(['quick', 'changed'])('runs exact release-version consistency for version.json in %s mode', (tier) => {
    const selection = selectChecks(tier, changed('version.json'))

    expect(selection.checks.find((check) => check.id === 'test:release-version-consistency')?.command).toEqual(
      backendScriptTestCommand('release-version-consistency.test.mjs'),
    )
  })

  it('covers Electron package-version changes directly in quick mode and through all tests in changed mode', () => {
    expect(checkIds('quick', 'apps/electron/package.json')).toContain('test:release-version-consistency')
    expect(checkIds('changed', 'apps/electron/package.json')).toContain('test:backend')
  })

  it.each([
    ['knip.json', 'root config changed'],
    ['patches/example.patch', 'patched dependency changed'],
    ['.githooks/pre-push', 'repository hook changed'],
    ['apps/ui/package.json', 'dependency/workspace config changed'],
  ])('routes %s conservatively across the repository', (file, reason) => {
    const selection = selectChecks('changed', changed(file))
    const ids = selection.checks.map((check) => check.id)

    expect(ids).toContain('lint')
    expect(ids).toContain('typecheck:native-messaging-host')
    expect(ids).toContain('test:electron')
    expect(selection.failureHints.join('\n')).toContain(reason)
  })

  it('keeps Docker verification in the full gate', () => {
    expect(checkIds('full')).toEqual(expect.arrayContaining([
      'test',
      'typecheck',
      'verify:dockerignore',
      'build',
    ]))
  })
})
