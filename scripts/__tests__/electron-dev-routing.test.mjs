import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
)

describe('Electron development backend routing', () => {
  it('lets every renderer derive the Electron backend host from its own page', () => {
    const script = packageJson.scripts['dev:electron']

    expect(script).toContain('VITE_FORGE_WS_PORT=47287')
    expect(script).not.toContain('VITE_FORGE_WS_URL=')
  })

  it('keeps remote mode as a thin network-exposure wrapper around the same routing', () => {
    const script = packageJson.scripts['dev:electron:remote']

    expect(script).toContain('FORGE_HOST=0.0.0.0')
    expect(script).toContain('pnpm dev:electron')
    expect(script).not.toContain('VITE_FORGE_WS_URL=')
  })
})
