import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveWindowsCiSigningEnv } from '../windows-ci-signing-env.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const workflowPath = path.join(repoRoot, '.github/workflows/electron-build.yml')

const signingVariables = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_NAME',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'CSC_FOR_PULL_REQUEST',
  'FORGE_WINDOWS_SIGNER_SUBJECT',
]

describe('Windows CI unsigned release policy', () => {
  it.each([
    ['workflow_dispatch', 'release'],
    ['push', 'validation'],
  ])('blanks all signing material and disables identity discovery for %s', (eventName, buildMode) => {
    const leaked = {
      WIN_CSC_LINK: 'live-cert',
      WIN_CSC_KEY_PASSWORD: 'live-password',
      WIN_CSC_NAME: 'live-name',
      CSC_LINK: 'alias-cert',
      CSC_KEY_PASSWORD: 'alias-password',
      CSC_NAME: 'alias-name',
      CSC_FOR_PULL_REQUEST: 'true',
      FORGE_WINDOWS_SIGNER_SUBJECT: 'CN=Leaked',
      CSC_IDENTITY_AUTO_DISCOVERY: 'true',
    }
    expect(resolveWindowsCiSigningEnv({ eventName, env: leaked })).toEqual({
      FORGE_EXTERNAL_CHROME_BUILD_MODE: buildMode,
      WIN_CSC_LINK: '',
      WIN_CSC_KEY_PASSWORD: '',
      WIN_CSC_NAME: '',
      CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      CSC_NAME: '',
      CSC_FOR_PULL_REQUEST: '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      FORGE_WINDOWS_SIGNER_SUBJECT: '',
    })
  })

  it('keeps electron-build.yml credential-free and explicitly disables all Windows signing', async () => {
    const source = await readFile(workflowPath, 'utf8')

    expect(source).not.toContain('secrets.')
    expect(source).toContain('windows-ci-signing-env.mjs --export-shell')
    expect(source).toContain('GITHUB_EVENT_NAME: ${{ github.event_name }}')
    expect(source).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    for (const variable of signingVariables) {
      expect(source).toContain(`echo "${variable}="`)
    }
    expect(source).not.toMatch(/required for release builds/u)
  })
})
