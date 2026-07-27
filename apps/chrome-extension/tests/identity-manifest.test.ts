import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const expectedId = 'fcchfcnadajoejfbiclihglkmbcfhajd'
const requiredPermissions = ['alarms', 'debugger', 'nativeMessaging', 'scripting', 'storage', 'tabs', 'webNavigation']

function deriveId(der: Buffer): string {
  return [...createHash('sha256').update(der).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join('')
}

describe('pinned offline identity and narrowed MV3 ledger', () => {
  it('derives the pinned extension ID and public hash without private material', async () => {
    const base64 = (await readFile(path.join(root, 'identity/production-public-key.b64'), 'utf8')).trim()
    const der = Buffer.from(base64, 'base64')
    expect(deriveId(der)).toBe(expectedId)
    expect(createHash('sha256').update(der).digest('hex')).toBe('522752d0309e495182b876bac125709358fd32fd1d105bcd5fce42966eb25b93')
    expect(base64).not.toContain('PRIVATE')
  })

  it('retains only permissions used by automatic operation-scoped control', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.shell.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      manifest_version: 3, minimum_chrome_version: '125', name: 'Forge',
      background: { service_worker: 'shell/service-worker-bootstrap.js' },
      action: { default_title: 'Open Forge' }, host_permissions: ['<all_urls>'],
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
    })
    expect(manifest.permissions).toEqual(requiredPermissions)
    expect(manifest).not.toHaveProperty('side_panel')
    expect(manifest).not.toHaveProperty('optional_permissions')
    expect(manifest).not.toHaveProperty('content_scripts')
    expect(manifest).not.toHaveProperty('externally_connectable')
  })

  it('contains no side-panel attach assets or authoritative attach copy', async () => {
    const [build, runtime] = await Promise.all([
      readFile(path.join(root, 'scripts/build.mjs'), 'utf8'),
      readFile(path.join(root, 'src/payload/service-worker/index.ts'), 'utf8'),
    ])
    expect(build).not.toMatch(/side-panel/u)
    expect(runtime).not.toMatch(/picker\.(?:claim|create|list)/u)
    expect(runtime).not.toMatch(/tabGroups|\.group\(/u)
  })
})
