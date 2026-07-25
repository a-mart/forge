import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertReleaseSigningSecretsPresent,
  resolveWindowsCiSigningEnv,
} from '../windows-ci-signing-env.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const workflowPath = path.join(repoRoot, '.github/workflows/electron-build.yml')
const RELEASE_SECRET_GUARD = "github.event_name == 'workflow_dispatch' && secrets."

describe('Windows CI signing credential isolation', () => {
  it('blanks signing material and disables identity discovery for validation pushes', () => {
    const leaked = {
      WIN_CSC_LINK: 'live-cert',
      WIN_CSC_KEY_PASSWORD: 'live-password',
      CSC_LINK: 'alias-cert',
      CSC_KEY_PASSWORD: 'alias-password',
      FORGE_WINDOWS_SIGNER_SUBJECT: 'CN=Leaked',
      CSC_IDENTITY_AUTO_DISCOVERY: 'true',
    }
    expect(resolveWindowsCiSigningEnv({ eventName: 'push', env: leaked })).toEqual({
      FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation',
      WIN_CSC_LINK: '',
      WIN_CSC_KEY_PASSWORD: '',
      CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      FORGE_WINDOWS_SIGNER_SUBJECT: '',
    })
  })

  it('passes release signing secrets through for workflow_dispatch and blanks CSC aliases', () => {
    const secrets = {
      WIN_CSC_LINK: 'release-cert',
      WIN_CSC_KEY_PASSWORD: 'release-password',
      FORGE_WINDOWS_SIGNER_SUBJECT: 'CN=Forge Release',
      CSC_LINK: 'should-not-win',
      CSC_KEY_PASSWORD: 'should-not-win',
    }
    const resolved = resolveWindowsCiSigningEnv({ eventName: 'workflow_dispatch', env: secrets })
    expect(resolved).toEqual({
      FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release',
      WIN_CSC_LINK: 'release-cert',
      WIN_CSC_KEY_PASSWORD: 'release-password',
      FORGE_WINDOWS_SIGNER_SUBJECT: 'CN=Forge Release',
      CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'true',
    })
    expect(() => assertReleaseSigningSecretsPresent(resolved)).not.toThrow()
    expect(() => assertReleaseSigningSecretsPresent({
      WIN_CSC_LINK: '',
      WIN_CSC_KEY_PASSWORD: 'x',
      FORGE_WINDOWS_SIGNER_SUBJECT: 'CN=x',
    })).toThrow(/WIN_CSC_LINK/)
  })

  it('keeps electron-build.yml credential-free on push and fail-closed on workflow_dispatch', async () => {
    const source = await readFile(workflowPath, 'utf8')

    for (const secret of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'FORGE_WINDOWS_SIGNER_SUBJECT']) {
      const guarded = `\${{ ${RELEASE_SECRET_GUARD}${secret} || '' }}`
      expect(source).toContain(guarded)
      // Exactly two gated injections: credential gate step + package step.
      expect(source.split(guarded).length - 1).toBe(2)
    }

    // No bare secrets.* injection remaining in the workflow source.
    expect(source).not.toMatch(/\$\{\{\s*secrets\.(WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD|FORGE_WINDOWS_SIGNER_SUBJECT)\s*\}\}/)
    expect(source).toContain('windows-ci-signing-env.mjs --export-shell')
    expect(source).toContain('GITHUB_EVENT_NAME: ${{ github.event_name }}')
    expect(source).toContain('WIN_CSC_LINK is required for release builds')
    expect(source).toContain('WIN_CSC_KEY_PASSWORD is required for release builds')
    expect(source).toContain('FORGE_WINDOWS_SIGNER_SUBJECT is required for release builds')
  })
})
