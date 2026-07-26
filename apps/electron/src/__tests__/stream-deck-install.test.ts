import { describe, expect, it } from 'vitest'
import { resolveStreamDeckAppPath, resolveStreamDeckPluginPath, STREAM_DECK_PLUGIN_FILENAME } from '../stream-deck-install.js'

describe('Stream Deck installer resolution', () => {
  it('uses the immutable packaged resources directory in released Forge', () => {
    expect(resolveStreamDeckPluginPath({
      isPackaged: true,
      resourcesPath: '/Applications/Forge.app/Contents/Resources',
      appPath: '/Applications/Forge.app/Contents/Resources/app.asar',
    })).toBe(`/Applications/Forge.app/Contents/Resources/stream-deck/${STREAM_DECK_PLUGIN_FILENAME}`)
  })

  it('resolves the sibling Stream Deck workspace during development', () => {
    expect(resolveStreamDeckPluginPath({
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: '/repo/apps/electron',
    })).toBe(`/repo/apps/stream-deck/${STREAM_DECK_PLUGIN_FILENAME}`)
  })

  it('finds the supported Stream Deck application paths', () => {
    expect(resolveStreamDeckAppPath('darwin', (candidate) => candidate === '/Applications/Stream Deck.app'))
      .toBe('/Applications/Stream Deck.app')
    expect(resolveStreamDeckAppPath('win32', (candidate) => candidate.endsWith('Stream Deck/StreamDeck.exe'), {
      ProgramFiles: 'C:\\Program Files',
    })).toBe('C:\\Program Files/Elgato/Stream Deck/StreamDeck.exe')
    expect(resolveStreamDeckAppPath('linux', () => true)).toBeNull()
  })
})
