import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { stageBrowserRuntime } from '../../apps/electron/scripts/build-all.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const noticePath = join(repoRoot, 'THIRD_PARTY_NOTICES.md')
const stagedNoticePath = join(repoRoot, 'apps/electron/.stage/browser-runtime/THIRD_PARTY_NOTICES.md')

const ADAPTED_SOURCES = [
  {
    path: 'packages/protocol/src/browser-automation.ts',
    marker: 'adapted from',
  },
  {
    path: 'apps/electron/src/browser/managed-electron-target-adapter.ts',
    marker: 'substantially adapted from T3 Code',
  },
  {
    path: 'apps/electron/src/browser/browser-session.ts',
    marker: 'adapted from T3 Code',
  },
  {
    path: 'apps/electron/src/browser/playwright-injected-runtime.ts',
    marker: 'adapted from T3 Code',
  },
  {
    path: 'apps/electron/src/browser/guest-preload.ts',
    marker: 'adapted from T3 Code',
  },
  {
    path: 'apps/electron/src/browser/browser-webview-security.ts',
    marker: 'follows T3 Code',
  },
  {
    path: 'apps/electron/src/browser/browser-keyboard.ts',
    marker: 'adapted from T3 Code',
  },
  {
    path: 'apps/electron/src/browser/trusted-browser-bridge.ts',
    marker: 'follows T3 Code',
  },
]

describe('browser third-party notices attribution', () => {
  let relocatedNotice = null

  afterEach(async () => {
    if (!relocatedNotice) return
    if (!existsSync(noticePath) && existsSync(relocatedNotice)) {
      await rename(relocatedNotice, noticePath)
    }
    await rm(dirname(relocatedNotice), { recursive: true, force: true })
    relocatedNotice = null
  })

  it('keeps the exact T3 MIT notice, adapted-file mapping, and Playwright license pointer', async () => {
    const notice = await readFile(noticePath, 'utf8')
    expect(notice).toContain('Copyright (c) 2026 T3 Tools Inc.')
    expect(notice).toContain('9a0a07167f0623c3a7db0ffeff2e3939760309df')
    expect(notice).toContain('Permission is hereby granted, free of charge')
    expect(notice).toContain('Substantial adapted-file mapping')
    expect(notice).toContain('apps/electron/src/browser/managed-electron-target-adapter.ts')
    expect(notice).toContain('apps/desktop/src/preview/Manager.ts')
    expect(notice).toContain('playwright-core 1.60.0')
    expect(notice).toContain('browser-runtime/playwright-core/')
    expect(notice).toContain('LICENSE, NOTICE, and ThirdPartyNotices.txt')
  })

  it('preserves source attribution headers on substantially adapted files', async () => {
    for (const source of ADAPTED_SOURCES) {
      const contents = await readFile(join(repoRoot, source.path), 'utf8')
      expect(contents, source.path).toContain(source.marker)
      expect(contents, source.path).toMatch(/9a0a0716/)
    }
  })

  it('stages the exact maintained notice bytes and fails closed when it is missing', async () => {
    await stageBrowserRuntime()
    const rootBytes = await readFile(noticePath)
    const stagedBytes = await readFile(stagedNoticePath)
    expect(stagedBytes.equals(rootBytes)).toBe(true)
    expect(createHash('sha256').update(stagedBytes).digest('hex')).toBe(
      createHash('sha256').update(rootBytes).digest('hex'),
    )

    const holding = await mkdtemp(join(tmpdir(), 'forge-missing-notice-'))
    relocatedNotice = join(holding, 'THIRD_PARTY_NOTICES.md')
    await rename(noticePath, relocatedNotice)
    await expect(stageBrowserRuntime()).rejects.toThrow(/Maintained browser third-party notice is missing/)
  })
})
