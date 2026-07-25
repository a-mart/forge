/**
 * Windows Electron CI signing credential policy.
 *
 * workflow_dispatch → release: pass through WIN_CSC_* + signer subject, blank CSC_* aliases.
 * push (electron/*) → validation: blank all signing material and disable identity discovery.
 *
 * Invoked by `.github/workflows/electron-build.yml` so packaging cannot inherit live certs
 * on validation pushes even if a step accidentally receives repository secrets.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE_EVENT = 'workflow_dispatch'
const VALIDATION_EVENT = 'push'

export function resolveWindowsCiSigningEnv({ eventName, env = {} } = {}) {
  if (eventName === RELEASE_EVENT) {
    return {
      FORGE_EXTERNAL_CHROME_BUILD_MODE: 'release',
      WIN_CSC_LINK: env.WIN_CSC_LINK ?? '',
      WIN_CSC_KEY_PASSWORD: env.WIN_CSC_KEY_PASSWORD ?? '',
      FORGE_WINDOWS_SIGNER_SUBJECT: env.FORGE_WINDOWS_SIGNER_SUBJECT ?? '',
      // Prefer WIN_CSC_* on Windows CI; keep CSC_* blank so aliases cannot shadow release certs.
      CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'true',
    }
  }

  if (eventName === VALIDATION_EVENT) {
    return {
      FORGE_EXTERNAL_CHROME_BUILD_MODE: 'validation',
      WIN_CSC_LINK: '',
      WIN_CSC_KEY_PASSWORD: '',
      CSC_LINK: '',
      CSC_KEY_PASSWORD: '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      FORGE_WINDOWS_SIGNER_SUBJECT: '',
    }
  }

  throw new Error(`Unsupported Electron CI event for signing env: ${eventName || '<unset>'}`)
}

export function assertReleaseSigningSecretsPresent(env = {}) {
  const missing = []
  if (!env.WIN_CSC_LINK) missing.push('WIN_CSC_LINK')
  if (!env.WIN_CSC_KEY_PASSWORD) missing.push('WIN_CSC_KEY_PASSWORD')
  if (!env.FORGE_WINDOWS_SIGNER_SUBJECT) missing.push('FORGE_WINDOWS_SIGNER_SUBJECT')
  if (missing.length > 0) {
    throw new Error(`Windows release packaging requires ${missing.join(', ')}`)
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

function printExportShell(resolved) {
  for (const [key, value] of Object.entries(resolved)) {
    process.stdout.write(`export ${key}=${shellQuote(value)}\n`)
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME
  const resolved = resolveWindowsCiSigningEnv({ eventName, env })

  if (resolved.FORGE_EXTERNAL_CHROME_BUILD_MODE === 'release') {
    assertReleaseSigningSecretsPresent(resolved)
  }

  if (argv.includes('--export-shell')) {
    printExportShell(resolved)
    return resolved
  }

  if (argv.includes('--print-json')) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`)
    return resolved
  }

  throw new Error('Usage: windows-ci-signing-env.mjs --export-shell | --print-json')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
