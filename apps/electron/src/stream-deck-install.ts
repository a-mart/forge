import { existsSync } from 'node:fs'
import path from 'node:path'

export const STREAM_DECK_PLUGIN_FILENAME = 'com.forge.command-center.streamDeckPlugin'

export interface StreamDeckPluginStatus {
  supported: boolean
  isPackaged: boolean
  bundled: boolean
  streamDeckInstalled: boolean
  pluginVersion: string
}

export function resolveStreamDeckPluginPath(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'stream-deck', STREAM_DECK_PLUGIN_FILENAME)
    : path.resolve(options.appPath, '..', 'stream-deck', STREAM_DECK_PLUGIN_FILENAME)
}

export function getStreamDeckPluginStatus(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  platform: NodeJS.Platform
}): StreamDeckPluginStatus {
  const installerPath = resolveStreamDeckPluginPath(options)
  return {
    supported: options.platform === 'darwin' || options.platform === 'win32',
    isPackaged: options.isPackaged,
    bundled: existsSync(installerPath),
    streamDeckInstalled: resolveStreamDeckAppPath(options.platform) !== null,
    pluginVersion: '0.2.0',
  }
}

export function resolveStreamDeckAppPath(
  platform: NodeJS.Platform,
  exists: (candidate: string) => boolean = existsSync,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'darwin') {
    return [
      '/Applications/Elgato Stream Deck.app',
      '/Applications/Stream Deck.app',
    ].find(exists) ?? null
  }
  if (platform === 'win32') {
    const roots = [environment.ProgramFiles, environment['ProgramFiles(x86)']].filter(Boolean) as string[]
    return roots.flatMap((root) => [
      path.join(root, 'Elgato', 'StreamDeck', 'StreamDeck.exe'),
      path.join(root, 'Elgato', 'Stream Deck', 'StreamDeck.exe'),
    ]).find(exists) ?? null
  }
  return null
}
