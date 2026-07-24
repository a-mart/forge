import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const DEFAULT_ELECTRON_DEV_SERVER_URL = 'http://127.0.0.1:47188'
export const FORGE_ELECTRON_DEV_SERVER_URL_ENV = 'FORGE_ELECTRON_DEV_SERVER_URL'
export const FORGE_ELECTRON_USER_DATA_DIR_ENV = 'FORGE_ELECTRON_USER_DATA_DIR'

interface ElectronAppPathPort {
  isPackaged: boolean
  getPath(name: 'home' | 'sessionData' | 'userData'): string
  setPath(name: 'sessionData' | 'userData', value: string): void
}

export function applyElectronStartupOverrides(options: {
  app: ElectronAppPathPort
  env: NodeJS.ProcessEnv
}): { devServerUrl: string; userDataDir: string | null; sessionDataDir: string | null } {
  const { app, env } = options
  const devServerUrl = resolveDevServerUrl({
    isPackaged: app.isPackaged,
    value: env[FORGE_ELECTRON_DEV_SERVER_URL_ENV],
  })
  const rawUserDataDir = env[FORGE_ELECTRON_USER_DATA_DIR_ENV]

  if (rawUserDataDir === undefined) {
    return {
      devServerUrl,
      userDataDir: null,
      sessionDataDir: null,
    }
  }
  if (app.isPackaged) {
    throw new Error('FORGE_ELECTRON_USER_DATA_DIR is disabled in packaged builds')
  }

  const protectedPaths = [
    app.getPath('userData'),
    app.getPath('sessionData'),
    path.join(app.getPath('home'), '.forge'),
    path.join(app.getPath('home'), '.middleman'),
    env.FORGE_DATA_DIR,
    env.MIDDLEMAN_DATA_DIR,
  ].filter((value): value is string => typeof value === 'string' && path.isAbsolute(value))

  const requestedUserDataDir = resolveIsolatedUserDataDir(rawUserDataDir, {
    homeDir: app.getPath('home'),
    protectedPaths,
  })
  mkdirSync(requestedUserDataDir, { recursive: true, mode: 0o700 })

  const canonicalUserDataDir = realpathSync.native(requestedUserDataDir)
  assertIsolatedPath(canonicalUserDataDir, app.getPath('home'), protectedPaths.map(canonicalizeExistingPath))

  const sessionDataDir = path.join(canonicalUserDataDir, 'session-data')
  mkdirSync(sessionDataDir, { recursive: true, mode: 0o700 })
  const canonicalSessionDataDir = realpathSync.native(sessionDataDir)

  app.setPath('userData', canonicalUserDataDir)
  app.setPath('sessionData', canonicalSessionDataDir)

  return {
    devServerUrl,
    userDataDir: canonicalUserDataDir,
    sessionDataDir: canonicalSessionDataDir,
  }
}

export function resolveDevServerUrl(options: {
  isPackaged: boolean
  value: string | undefined
}): string {
  if (options.value === undefined) {
    return DEFAULT_ELECTRON_DEV_SERVER_URL
  }
  if (options.isPackaged) {
    throw new Error('FORGE_ELECTRON_DEV_SERVER_URL is disabled in packaged builds')
  }

  let url: URL
  try {
    url = new URL(options.value)
  } catch {
    throw new Error('FORGE_ELECTRON_DEV_SERVER_URL must be an absolute loopback URL')
  }

  const hostname = url.hostname.toLowerCase()
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isLoopback ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('FORGE_ELECTRON_DEV_SERVER_URL must be an absolute loopback URL')
  }

  return url.toString()
}

export function resolveIsolatedUserDataDir(
  value: string,
  options: {
    homeDir: string
    protectedPaths: readonly string[]
  },
): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw new Error('FORGE_ELECTRON_USER_DATA_DIR must be an absolute isolated directory')
  }

  const resolved = path.resolve(value)
  assertIsolatedPath(resolved, options.homeDir, options.protectedPaths)
  return resolved
}

function assertIsolatedPath(
  candidate: string,
  homeDir: string,
  protectedPaths: readonly string[],
): void {
  if (
    candidate === path.parse(candidate).root ||
    path.resolve(candidate) === path.resolve(homeDir) ||
    isPathWithin(candidate, homeDir)
  ) {
    throw new Error('FORGE_ELECTRON_USER_DATA_DIR must be an absolute isolated directory')
  }

  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(candidate, protectedPath)) {
      throw new Error('FORGE_ELECTRON_USER_DATA_DIR must not overlap existing Forge data')
    }
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const resolvedFirst = path.resolve(first)
  const resolvedSecond = path.resolve(second)
  return (
    resolvedFirst === resolvedSecond ||
    isPathWithin(resolvedFirst, resolvedSecond) ||
    isPathWithin(resolvedSecond, resolvedFirst)
  )
}

function isPathWithin(candidateParent: string, candidateChild: string): boolean {
  const relative = path.relative(path.resolve(candidateParent), path.resolve(candidateChild))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function canonicalizeExistingPath(value: string): string {
  if (!existsSync(value)) {
    return path.resolve(value)
  }
  try {
    return realpathSync.native(value)
  } catch {
    return path.resolve(value)
  }
}
