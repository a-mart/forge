import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDevBetterSqlite3Binding } from '../dev-native-binding.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

function createFixture(overrides: Record<string, string> = {}) {
  const electronDir = mkdtempSync(path.join(os.tmpdir(), 'forge-electron-native-'))
  temporaryDirectories.push(electronDir)
  const cacheRoot = path.join(electronDir, '.dev-native', 'better-sqlite3')
  const bindingPath = path.join(cacheRoot, 'test-cache', 'better_sqlite3.node')
  mkdirSync(path.dirname(bindingPath), { recursive: true })
  writeFileSync(bindingPath, 'fixture')
  writeFileSync(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
    bindingPath,
    electronVersion: '37.10.3',
    moduleVersion: '12.9.0',
    platform: process.platform,
    arch: process.arch,
    sourceFingerprint: 'fingerprint',
    ...overrides,
  }))
  return { electronDir, bindingPath }
}

function resolveFixture(electronDir: string) {
  return resolveDevBetterSqlite3Binding({
    electronDir,
    electronVersion: '37.10.3',
    platform: process.platform,
    arch: process.arch,
  })
}

describe('resolveDevBetterSqlite3Binding', () => {
  it('returns a verified cache-local binding path', () => {
    const fixture = createFixture()
    expect(resolveFixture(fixture.electronDir)).toBe(fixture.bindingPath)
  })

  it('rejects a binding prepared for another Electron version', () => {
    const fixture = createFixture({ electronVersion: '38.0.0' })
    expect(() => resolveFixture(fixture.electronDir)).toThrow('targets Electron 38.0.0')
  })

  it('rejects manifest paths outside the development cache', () => {
    const electronDir = mkdtempSync(path.join(os.tmpdir(), 'forge-electron-native-'))
    temporaryDirectories.push(electronDir)
    const cacheRoot = path.join(electronDir, '.dev-native', 'better-sqlite3')
    const outsideBinding = path.join(electronDir, 'outside.node')
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(outsideBinding, 'fixture')
    writeFileSync(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
      bindingPath: outsideBinding,
      electronVersion: '37.10.3',
      moduleVersion: '12.9.0',
      platform: process.platform,
      arch: process.arch,
      sourceFingerprint: 'fingerprint',
    }))

    expect(() => resolveFixture(electronDir)).toThrow('resolves outside its cache')
  })
})
