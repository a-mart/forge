import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ELECTRON_DEV_SERVER_URL,
  applyElectronStartupOverrides,
  resolveDevServerUrl,
  resolveIsolatedUserDataDir,
} from '../startup-overrides.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('resolveDevServerUrl', () => {
  it.each([
    'http://127.0.0.1:4173',
    'https://localhost:47188/ui/',
    'http://[::1]:47188',
  ])('accepts an absolute HTTP(S) loopback URL: %s', (value) => {
    expect(resolveDevServerUrl({ isPackaged: false, value })).toBe(new URL(value).toString())
  })

  it.each([
    'http://192.168.1.10:47188',
    'https://example.com',
    'file:///tmp/renderer.html',
    '/relative/renderer',
    'http://user:password@localhost:47188',
    'http://localhost:47188/?token=value',
  ])('rejects unsafe development renderer URLs: %s', (value) => {
    expect(() => resolveDevServerUrl({ isPackaged: false, value }))
      .toThrow('must be an absolute loopback URL')
  })

  it('uses the fixed default and rejects any packaged override', () => {
    expect(resolveDevServerUrl({ isPackaged: true, value: undefined }))
      .toBe(DEFAULT_ELECTRON_DEV_SERVER_URL)
    expect(() => resolveDevServerUrl({
      isPackaged: true,
      value: 'http://127.0.0.1:47188',
    })).toThrow('disabled in packaged builds')
  })
})

describe('isolated Electron user data override', () => {
  it('sets absolute userData and nested sessionData paths before startup continues', () => {
    const root = makeTemporaryDirectory()
    const home = path.join(root, 'home')
    const currentUserData = path.join(home, 'Library', 'Application Support', 'Forge')
    const currentSessionData = path.join(currentUserData, 'Session Data')
    const isolatedUserData = path.join(root, 'isolated', 'electron-user-data')
    mkdirSync(currentSessionData, { recursive: true })
    const setPath = vi.fn()
    const app = {
      isPackaged: false,
      getPath: (name: 'home' | 'sessionData' | 'userData') => ({
        home,
        sessionData: currentSessionData,
        userData: currentUserData,
      })[name],
      setPath,
    }

    const result = applyElectronStartupOverrides({
      app,
      env: {
        FORGE_ELECTRON_DEV_SERVER_URL: 'http://localhost:49111',
        FORGE_ELECTRON_USER_DATA_DIR: isolatedUserData,
        FORGE_DATA_DIR: path.join(root, 'forge-backend-data'),
      },
    })
    const canonicalIsolatedUserData = realpathSync.native(isolatedUserData)

    expect(result).toEqual({
      devServerUrl: 'http://localhost:49111/',
      userDataDir: canonicalIsolatedUserData,
      sessionDataDir: path.join(canonicalIsolatedUserData, 'session-data'),
    })
    expect(setPath.mock.calls).toEqual([
      ['userData', canonicalIsolatedUserData],
      ['sessionData', path.join(canonicalIsolatedUserData, 'session-data')],
    ])
  })

  it('rejects relative, broad, default, and backend-overlapping directories', () => {
    const root = makeTemporaryDirectory()
    const home = path.join(root, 'home')
    const currentUserData = path.join(home, '.current-electron')
    const backendData = path.join(root, 'backend-data')

    expect(() => resolveIsolatedUserDataDir('relative/data', {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must be an absolute isolated directory')
    expect(() => resolveIsolatedUserDataDir(path.parse(root).root, {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must be an absolute isolated directory')
    expect(() => resolveIsolatedUserDataDir(currentUserData, {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must not overlap existing Forge data')
    expect(() => resolveIsolatedUserDataDir(path.join(backendData, 'electron'), {
      homeDir: home,
      protectedPaths: [currentUserData, backendData],
    })).toThrow('must not overlap existing Forge data')
  })

  it('rejects user data overrides in packaged builds without mutating paths', () => {
    const root = makeTemporaryDirectory()
    const setPath = vi.fn()
    const app = {
      isPackaged: true,
      getPath: (name: 'home' | 'sessionData' | 'userData') => path.join(root, name),
      setPath,
    }

    expect(() => applyElectronStartupOverrides({
      app,
      env: {
        FORGE_ELECTRON_USER_DATA_DIR: path.join(root, 'isolated'),
      },
    })).toThrow('disabled in packaged builds')
    expect(setPath).not.toHaveBeenCalled()
  })
})

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'forge-electron-overrides-'))
  temporaryDirectories.push(directory)
  return directory
}
