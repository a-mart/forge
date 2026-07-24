import { describe, expect, it } from 'vitest'
import { createBackendForkOptions } from '../backend-fork-options.js'

function createInput() {
  return {
    runtimeRoot: '/repo',
    inheritedEnv: {
      PATH: '/bin',
      FORGE_BETTER_SQLITE3_NATIVE_BINDING: '/stale/binding.node',
    },
    isPackaged: false,
    backendPort: 47287,
    resourcesDir: '/repo/resources',
    appVersion: '0.22.0',
    electronVersion: '37.10.3',
    execArgv: ['--import', 'tsx'],
    secureControlToken: 'test-secure-control-token-that-is-long-enough',
    devBetterSqlite3Binding: '/repo/.dev-native/better_sqlite3.node',
  }
}

describe('createBackendForkOptions', () => {
  it('keeps Electron as the implicit backend runtime and passes the verified development binding', () => {
    const options = createBackendForkOptions(createInput())

    expect(options).not.toHaveProperty('execPath')
    expect(options.cwd).toBe('/repo')
    expect(options.execArgv).toEqual(['--import', 'tsx'])
    expect(options.env).toMatchObject({
      PATH: '/bin',
      FORGE_DESKTOP: '1',
      FORGE_ELECTRON_DEV: '1',
      FORGE_PORT: '47287',
      FORGE_BETTER_SQLITE3_NATIVE_BINDING: '/repo/.dev-native/better_sqlite3.node',
      FORGE_SECURE_CONTROL_TOKEN: 'test-secure-control-token-that-is-long-enough',
    })
  })

  it('does not expose the development binding to packaged backends', () => {
    const options = createBackendForkOptions({
      ...createInput(),
      isPackaged: true,
      devBetterSqlite3Binding: undefined,
    })

    expect(options).not.toHaveProperty('execPath')
    expect(options.env?.FORGE_ELECTRON_DEV).toBe('0')
    expect(options.env?.FORGE_BETTER_SQLITE3_NATIVE_BINDING).toBeUndefined()
  })

  it('fails before launch when the development binding was not prepared', () => {
    expect(() => createBackendForkOptions({
      ...createInput(),
      devBetterSqlite3Binding: undefined,
    })).toThrow('requires a verified better-sqlite3 native binding')
  })
})
