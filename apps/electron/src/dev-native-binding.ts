import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

interface DevNativeBindingManifest {
  bindingPath: string
  electronVersion: string
  moduleVersion: string
  platform: string
  arch: string
  sourceFingerprint: string
}

interface ResolveDevNativeBindingOptions {
  electronDir: string
  electronVersion: string
  platform: NodeJS.Platform
  arch: string
}

export function resolveDevBetterSqlite3Binding({
  electronDir,
  electronVersion,
  platform,
  arch,
}: ResolveDevNativeBindingOptions): string {
  const cacheRoot = path.resolve(electronDir, '.dev-native', 'better-sqlite3')
  const manifestPath = path.join(cacheRoot, 'manifest.json')

  let manifest: DevNativeBindingManifest
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Electron development native binding is unavailable at ${manifestPath}. Run pnpm --dir apps/electron prepare:dev-native. ${toErrorMessage(error)}`,
    )
  }

  if (manifest.electronVersion !== electronVersion) {
    throw new Error(
      `Electron development native binding targets Electron ${manifest.electronVersion}, but the running version is ${electronVersion}. Run pnpm --dir apps/electron prepare:dev-native.`,
    )
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(
      `Electron development native binding targets ${manifest.platform}/${manifest.arch}, but the running platform is ${platform}/${arch}. Run pnpm --dir apps/electron prepare:dev-native.`,
    )
  }

  const bindingPath = path.resolve(manifest.bindingPath)
  assertPathWithin(bindingPath, cacheRoot)
  if (!existsSync(bindingPath)) {
    throw new Error(
      `Electron development native binding from ${manifestPath} does not exist at ${bindingPath}. Run pnpm --dir apps/electron prepare:dev-native.`,
    )
  }

  return bindingPath
}

function parseManifest(source: string): DevNativeBindingManifest {
  const parsed: unknown = JSON.parse(source)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Manifest must be an object')
  }

  const manifest = parsed as Partial<DevNativeBindingManifest>
  for (const field of ['bindingPath', 'electronVersion', 'moduleVersion', 'platform', 'arch', 'sourceFingerprint'] as const) {
    if (typeof manifest[field] !== 'string' || !manifest[field]?.trim()) {
      throw new Error(`Manifest field ${field} must be a non-empty string`)
    }
  }

  return manifest as DevNativeBindingManifest
}

function assertPathWithin(targetPath: string, parentPath: string): void {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(targetPath))
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Electron development native binding resolves outside its cache: ${targetPath}`)
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
