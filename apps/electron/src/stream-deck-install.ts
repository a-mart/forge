import { existsSync } from 'node:fs'
import path from 'node:path'

export const STREAM_DECK_PLUGIN_FILENAME = 'com.forge.command-center.streamDeckPlugin'

export interface StreamDeckPluginStatus {
  supported: boolean
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
    bundled: existsSync(installerPath),
    streamDeckInstalled: detectStreamDeckApp(options.platform),
    pluginVersion: '0.2.0',
  }
}

function detectStreamDeckApp(platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') {
    return [
      '/Applications/Elgato Stream Deck.app',
      '/Applications/Stream Deck.app',
    ].some(existsSync)
  }
  if (platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
    return roots.some((root) =>
      existsSync(path.join(root, 'Elgato', 'StreamDeck', 'StreamDeck.exe')) ||
      existsSync(path.join(root, 'Elgato', 'Stream Deck', 'StreamDeck.exe')))
  }
  return false
}
