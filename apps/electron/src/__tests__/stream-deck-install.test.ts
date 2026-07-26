import { describe, expect, it } from 'vitest'
import { resolveStreamDeckPluginPath, STREAM_DECK_PLUGIN_FILENAME } from '../stream-deck-install.js'

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
})
