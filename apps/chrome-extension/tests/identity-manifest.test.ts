import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const expectedId = 'fcchfcnadajoejfbiclihglkmbcfhajd'
const requiredPermissions = [
  'alarms', 'bookmarks', 'debugger', 'downloads', 'favicon', 'history', 'nativeMessaging', 'notifications',
  'scripting', 'sessions', 'sidePanel', 'storage', 'tabGroups', 'tabs', 'topSites', 'webNavigation',
]

function deriveId(der: Buffer): string {
  return [...createHash('sha256').update(der).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble)).join('')
}

describe('pinned offline identity and MV3 ledger', () => {
  it('derives the pinned extension ID and public hash without private material', async () => {
    const base64 = (await readFile(path.join(root, 'identity/production-public-key.b64'), 'utf8')).trim()
    const der = Buffer.from(base64, 'base64')
    expect(deriveId(der)).toBe(expectedId)
    expect(createHash('sha256').update(der).digest('hex')).toBe('522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93')
    expect(base64).not.toContain('PRIVATE')
  })

  it('pins minimum Chrome, strict CSP, dynamic injection, and the broad permission ledger', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.shell.json'), 'utf8')) as Record<string, unknown>
    const base64 = (await readFile(path.join(root, 'identity/production-public-key.b64'), 'utf8')).trim()
    expect(manifest).toMatchObject({
      manifest_version: 3,
      minimum_chrome_version: '125',
      name: 'Forge External Chrome (Local Beta)',
      key: base64,
      background: { service_worker: 'shell/service-worker-bootstrap.js' },
      action: { default_title: 'Open Forge External Chrome' },
      side_panel: { default_path: 'shell/side-panel.html' },
      host_permissions: ['<all_urls>'],
      optional_permissions: ['downloads.open'],
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
    })
    expect(manifest.permissions).toEqual(requiredPermissions)
    expect(manifest).not.toHaveProperty('content_scripts')
    expect(manifest).not.toHaveProperty('externally_connectable')
    const runtimeSources = await Promise.all([
      'src/runtime/chrome-api.ts',
      'src/payload/service-worker/index.ts',
      'src/payload/content-script/index.ts',
      'src/payload/side-panel/index.ts',
    ].map((relative) => readFile(path.join(root, relative), 'utf8')))
    const executableSource = runtimeSources.join('\n')
    expect(executableSource).not.toMatch(/chrome(?:Api)?\.(?:bookmarks|history|topSites)\b/)
    expect(executableSource).not.toMatch(/downloads\.open\b/)
  })

  it('has no remote executable surface in the fixed side panel', async () => {
    const html = await readFile(path.join(root, 'public/side-panel.html'), 'utf8')
    expect(html).toContain('src="side-panel-bootstrap.js"')
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i)
    expect(html).not.toMatch(/\beval\s*\(/)
    expect(html).not.toMatch(/WebAssembly/)
  })

  it('ships accurate setup, attach, detach, and pending-lease side-panel copy', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.shell.json'), 'utf8')) as { description: string }
    const html = await readFile(path.join(root, 'public/side-panel.html'), 'utf8')
    const sidePanel = await readFile(path.join(root, 'src/payload/side-panel/index.ts'), 'utf8')
    expect(manifest.description.length).toBeLessThanOrEqual(132)
    expect(manifest.description).toContain('Local Beta')
    expect(manifest.description).toContain('unpacked')
    expect(manifest.description).toContain('Chrome 125+')
    expect(manifest.description).toContain('Developer Mode')
    expect(manifest.description).toContain('dedicated profile')
    expect(manifest.description).not.toMatch(/Test-side-load|milestone|M1/i)
    expect(html).toContain('Attach selected tabs')
    expect(html).toContain('New Forge group')
    expect(html).toContain('Leases can include tabs you select below')
    expect(html).toContain("tabs created with New Forge group or Forge's open operation")
    expect(html).toContain('qualifying grouped child tabs')
    expect(html).toContain('Detach leaves leased tabs open')
    expect(html).toContain('Detach leaves user tabs open')
    expect(html).toContain('dedicated Chrome profile')
    expect(html).toContain('Pending session label')
    expect(html).toContain('not the final Forge backend session mapping')
    expect(html).toContain('Chrome 125+')
    expect(html).toContain('download handling or saved artifacts')
    expect(html).toContain('opening downloaded files')
    expect(html).toContain('standalone screenshot export controls')
    expect(html).not.toMatch(/Claim selected|Create grouped tab|M1 spike|setup milestone/i)
    expect(sidePanel).toContain("'local'")
    expect(sidePanel).toContain('Detached. User tabs were left open.')
    expect(sidePanel).not.toMatch(/M1 spike|setup milestone/i)
  })
})
