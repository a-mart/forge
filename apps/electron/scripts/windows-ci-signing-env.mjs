#!/usr/bin/env node
/**
 * Windows Electron CI signing credential policy.
 *
 * workflow_dispatch → unsigned Windows release: blank all signing material and disable identity discovery.
 * push (electron/*) → validation: blank all signing material and disable identity discovery.
 *
 * Invoked by `.github/workflows/electron-build.yml` so credential-free Windows
 * packaging cannot inherit a runner or repository signing identity.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE_EVENT = 'workflow_dispatch'
const VALIDATION_EVENT = 'push'

function unsignedWindowsSigningEnvironment(buildMode) {
  return {
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
  }
}

export function resolveWindowsCiSigningEnv({ eventName, env = {} } = {}) {
  if (eventName === RELEASE_EVENT) return unsignedWindowsSigningEnvironment('release')
  if (eventName === VALIDATION_EVENT) return unsignedWindowsSigningEnvironment('validation')
  throw new Error(`Unsupported Electron CI event for signing env: ${eventName || '<unset>'}`)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function printExportShell(resolved) {
  for (const [key, value] of Object.entries(resolved)) {
    process.stdout.write(`export ${key}=${shellQuote(value)}\n`)
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME
  const resolved = resolveWindowsCiSigningEnv({ eventName, env })

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
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
