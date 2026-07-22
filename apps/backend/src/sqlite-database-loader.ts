import { existsSync } from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { SqliteDatabaseConstructor } from './swarm/types.js'

const ELECTRON_DEV_BINDING_ENV = 'FORGE_BETTER_SQLITE3_NATIVE_BINDING'

export async function loadConfiguredSqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
  const DatabaseConstructor = (await import('better-sqlite3')).default
  const nativeBinding = resolveElectronDevNativeBinding(process.env)
  return withNativeBinding(DatabaseConstructor, nativeBinding)
}

export function resolveElectronDevNativeBinding(env: NodeJS.ProcessEnv): string | undefined {
  if (env.FORGE_ELECTRON_DEV !== '1') {
    return undefined
  }

  const configuredPath = env[ELECTRON_DEV_BINDING_ENV]?.trim()
  if (!configuredPath) {
    throw new Error(
      `Electron development requires ${ELECTRON_DEV_BINDING_ENV}. Run pnpm --dir apps/electron prepare:dev-native before starting Electron.`,
    )
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`${ELECTRON_DEV_BINDING_ENV} must be an absolute path`)
  }
  if (!existsSync(configuredPath)) {
    throw new Error(`${ELECTRON_DEV_BINDING_ENV} does not exist at ${configuredPath}`)
  }

  return configuredPath
}

export function withNativeBinding(
  DatabaseConstructor: SqliteDatabaseConstructor,
  nativeBinding: string | undefined,
): SqliteDatabaseConstructor {
  if (!nativeBinding) {
    return DatabaseConstructor
  }

  return class ForgeElectronDevDatabase extends DatabaseConstructor {
    constructor(databasePath: string, options?: Database.Options) {
      super(databasePath, {
        ...options,
        nativeBinding,
      })
    }
  }
}
