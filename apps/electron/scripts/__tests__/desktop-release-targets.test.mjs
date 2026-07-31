import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const builderConfigPath = path.join(repoRoot, 'apps/electron/electron-builder.yml')
const secureSessionsWorkflowPath = path.join(repoRoot, '.github/workflows/secure-sessions.yml')

describe('desktop release and Secure Sessions container policy', () => {
  it('limits release artifacts to macOS and Windows while retaining only a non-publishable Linux directory target', async () => {
    const config = await readFile(builderConfigPath, 'utf8')

    expect(config).toMatch(/mac:\n\s+target:\n\s+- target: dmg\n\s+- target: zip/m)
    expect(config).toMatch(/win:\n\s+target:\n\s+- target: nsis/m)
    expect(config).toMatch(/linux:\n\s+target:\n\s+- target: dir/m)
    expect(config).not.toMatch(/target:\s*AppImage/m)
    expect(config).toContain('do not add Linux release artifacts here')
  })

  it('keeps the mandatory Docker Desktop guest-container gate distinct from Desktop packaging', async () => {
    const workflow = await readFile(secureSessionsWorkflowPath, 'utf8')

    expect(workflow).toContain('secure-container-e2e:')
    expect(workflow).not.toContain('docker-e2e:')
    expect(workflow).toContain('macOS and Windows Docker Desktop hosts')
    expect(workflow).toContain('not Linux Desktop packaging')
    expect(workflow).toContain('FORGE_REQUIRE_SECURE_DOCKER_E2E: "1"')
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain('branches:\n      - main')
  })
})
