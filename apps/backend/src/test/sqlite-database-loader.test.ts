import { createRequire } from 'node:module'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  resolveElectronDevNativeBinding,
  withNativeBinding,
} from '../sqlite-database-loader.js'

const require = createRequire(import.meta.url)
const sqlitePackagePath = require.resolve('better-sqlite3/package.json')
const hostNativeBinding = path.join(path.dirname(sqlitePackagePath), 'build', 'Release', 'better_sqlite3.node')

describe('resolveElectronDevNativeBinding', () => {
  it('ignores a stale binding outside Electron development', () => {
    expect(resolveElectronDevNativeBinding({
      FORGE_ELECTRON_DEV: '0',
      FORGE_BETTER_SQLITE3_NATIVE_BINDING: '/stale/binding.node',
    })).toBeUndefined()
  })

  it('requires a prepared absolute binding during Electron development', () => {
    expect(() => resolveElectronDevNativeBinding({ FORGE_ELECTRON_DEV: '1' })).toThrow(
      'Run pnpm --dir apps/electron prepare:dev-native',
    )
    expect(() => resolveElectronDevNativeBinding({
      FORGE_ELECTRON_DEV: '1',
      FORGE_BETTER_SQLITE3_NATIVE_BINDING: 'relative.node',
    })).toThrow('must be an absolute path')
  })

  it('accepts an existing absolute binding during Electron development', () => {
    expect(resolveElectronDevNativeBinding({
      FORGE_ELECTRON_DEV: '1',
      FORGE_BETTER_SQLITE3_NATIVE_BINDING: hostNativeBinding,
    })).toBe(hostNativeBinding)
  })
})

describe('withNativeBinding', () => {
  it('preserves the normal constructor when no override is required', () => {
    expect(withNativeBinding(Database, undefined)).toBe(Database)
  })

  it('opens SQLite through the explicitly selected native binding', () => {
    const ElectronDevDatabase = withNativeBinding(Database, hostNativeBinding)
    const database = new ElectronDevDatabase(':memory:')
    try {
      expect(database.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 })
    } finally {
      database.close()
    }
  })
})
