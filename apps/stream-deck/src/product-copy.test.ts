import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const pluginRoot = path.resolve(import.meta.dirname, '../com.forge.command-center.sdPlugin')

describe('Stream Deck browser product copy', () => {
  it('uses Automatic Browser in the action manifest and property inspector', async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'manifest.json'), 'utf8')) as {
      Actions: Array<{ UUID: string; Tooltip?: string }>
    }
    const viewAction = manifest.Actions.find((action) => action.UUID === 'com.forge.command-center.view')
    const inspector = await readFile(path.join(pluginRoot, 'ui/inspector.html'), 'utf8')

    expect(viewAction?.Tooltip).toBe('Open Chat, Source Control, Automatic Browser, Terminal, or Statistics')
    expect(inspector).toContain('<option value="browser">Automatic Browser</option>')
    expect(`${viewAction?.Tooltip}\n${inspector}`).not.toContain('Managed Browser')
  })
})
