import type { ForkOptions } from 'node:child_process'

interface CreateBackendForkOptionsInput {
  runtimeRoot: string
  inheritedEnv: NodeJS.ProcessEnv
  isPackaged: boolean
  backendPort: number
  resourcesDir: string
  appVersion: string
  electronVersion: string
  execArgv: string[]
  devBetterSqlite3Binding?: string
}

export function createBackendForkOptions({
  runtimeRoot,
  inheritedEnv,
  isPackaged,
  backendPort,
  resourcesDir,
  appVersion,
  electronVersion,
  execArgv,
  devBetterSqlite3Binding,
}: CreateBackendForkOptionsInput): ForkOptions {
  if (!isPackaged && !devBetterSqlite3Binding) {
    throw new Error('Electron development backend requires a verified better-sqlite3 native binding')
  }

  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    FORGE_DESKTOP: '1',
    FORGE_ELECTRON_DEV: isPackaged ? '0' : '1',
    FORGE_HOST: inheritedEnv.FORGE_HOST || '0.0.0.0',
    FORGE_PORT: inheritedEnv.FORGE_PORT || String(backendPort),
    FORGE_RESOURCES_DIR: resourcesDir,
    FORGE_APP_VERSION: appVersion,
    FORGE_ELECTRON_VERSION: electronVersion,
  }

  delete env.FORGE_SECURE_CONTROL_TOKEN
  delete env.FORGE_BETTER_SQLITE3_NATIVE_BINDING
  if (!isPackaged) {
    env.FORGE_BETTER_SQLITE3_NATIVE_BINDING = devBetterSqlite3Binding
  }

  return {
    cwd: runtimeRoot,
    env,
    // fd 4 is a one-shot parent-to-backend capability pipe. Keeping the
    // value out of argv and env prevents runtime children from inheriting it.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
    execArgv,
    // Intentionally omit execPath. Electron must fork the backend with its
    // embedded Node runtime so provider and desktop behavior stay unchanged.
  }
}
