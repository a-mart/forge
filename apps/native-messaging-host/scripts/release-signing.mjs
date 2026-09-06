import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const macReleaseEntitlementsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'build',
  'entitlements.mac.plist',
)

const execFileAsync = promisify(execFile)
export const SEA_NODE_VERSION = '26.5.0'

export function externalChromeBuildMode(env = process.env) {
  const mode = env.FORGE_EXTERNAL_CHROME_BUILD_MODE ?? (env.FORGE_EXTERNAL_CHROME_VALIDATION_ONLY === '1' ? 'validation' : 'release')
  if (mode !== 'release' && mode !== 'validation') {
    throw new Error('FORGE_EXTERNAL_CHROME_BUILD_MODE must be release or validation')
  }
  return mode
}

export async function assertReleaseEnvironment({
  platform = process.platform,
  env = process.env,
  access = stat,
} = {}) {
  const mode = externalChromeBuildMode(env)
  const seaNode = env.FORGE_SEA_NODE
  if (mode === 'release' && !seaNode) {
    throw new Error('Release packaging requires FORGE_SEA_NODE to point to the official pinned Node executable')
  }
  if (seaNode) {
    try {
      await access(seaNode)
    } catch {
      throw new Error(`FORGE_SEA_NODE is not accessible: ${seaNode}`)
    }
  }
  if (mode === 'validation') return { mode, seaNode: seaNode ?? process.execPath }

  if (platform === 'darwin') {
    requireEnvironment(env, [
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
      'FORGE_MACOS_SIGNING_IDENTITY',
    ], 'macOS release packaging')
  } else if (platform !== 'win32') {
    throw new Error(`External Chrome release packaging is not configured for ${platform}; use validation mode`)
  }
  return { mode, seaNode }
}

export function assertSeaToolchain({
  nodeVersion = process.versions.node,
  execPath = process.execPath,
  env = process.env,
} = {}) {
  // Validation packages the same Node executable that runs this package script.
  // Its SEA build and executable smoke are the capability gates, including
  // Windows blob injection when direct --build-sea is unavailable. Release artifacts
  // remain qualified to the separately pinned official Node distribution.
  if (externalChromeBuildMode(env) !== 'release') return

  if (nodeVersion !== SEA_NODE_VERSION) {
    throw new Error(`External Chrome SEA release packaging requires official Node ${SEA_NODE_VERSION}; running ${nodeVersion}`)
  }
  const expected = path.resolve(env.FORGE_SEA_NODE ?? '')
  if (!expected || path.resolve(execPath) !== expected) {
    throw new Error(`SEA release packaging must run with FORGE_SEA_NODE (${expected || '<unset>'}), not ${execPath}`)
  }
}

export async function prepareExecutableForInitialSmoke(executable, {
  platform = process.platform,
  runCommand = defaultRunCommand,
} = {}) {
  if (platform !== 'darwin') return
  await runCommand('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', macReleaseEntitlementsPath, executable])
  await runCommand('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', executable])
}

export async function prepareReleaseExecutable(executable, {
  platform = process.platform,
  env = process.env,
  runCommand = defaultRunCommand,
} = {}) {
  const mode = externalChromeBuildMode(env)
  const scheme = platform === 'darwin' ? 'developer-id' : platform === 'win32' ? 'authenticode' : 'packaged-resource-hash'
  if (mode === 'validation') {
    return { scheme, mode, verified: false, signer: null, teamId: null }
  }

  await assertReleaseEnvironment({ platform, env })
  if (platform === 'darwin') {
    const identity = env.FORGE_MACOS_SIGNING_IDENTITY
    const teamId = env.APPLE_TEAM_ID
    await runCommand('/usr/bin/codesign', [
      '--force', '--options', 'runtime', '--timestamp', '--sign', identity,
      '--entitlements', macReleaseEntitlementsPath, executable,
    ])
    const signature = await inspectMacSignature(executable, { runCommand })
    if (signature.signer !== identity) {
      throw new Error(`External Chrome native host signer mismatch: expected ${identity}, got ${signature.signer ?? '<none>'}`)
    }
    if (signature.teamId !== teamId) {
      throw new Error(`External Chrome native host team mismatch: expected ${teamId}, got ${signature.teamId ?? '<none>'}`)
    }
    return { scheme, mode, verified: true, ...signature }
  }
  if (platform === 'win32') {
    // Windows release hosts are deliberately unsigned. Their production trust
    // boundary is the pinned release manifest plus strict file SHA-256 checks.
    return { scheme: 'unsigned', mode, verified: false, signer: null, teamId: null }
  }
  throw new Error(`External Chrome release signing is unsupported on ${platform}`)
}

export async function verifyReleaseSignature(executable, signature, {
  platform = process.platform,
  allowValidation = false,
  runCommand = defaultRunCommand,
} = {}) {
  if (signature?.mode === 'validation' && signature.verified === false) {
    if (!allowValidation) throw new Error('External Chrome validation-only native host is not release signed')
    return signature
  }

  const unsignedWindowsRelease = platform === 'win32' &&
    signature?.scheme === 'unsigned' && signature.mode === 'release' && signature.verified === false &&
    signature.signer === null && signature.teamId === null
  if (unsignedWindowsRelease) return signature

  if (signature?.mode !== 'release' || signature.verified !== true) {
    throw new Error('External Chrome native host has invalid release-signature metadata')
  }
  if (platform === 'darwin') {
    if (signature.scheme !== 'developer-id' || typeof signature.signer !== 'string' || typeof signature.teamId !== 'string') {
      throw new Error('External Chrome macOS native host has invalid Developer ID signature metadata')
    }
    const observed = await inspectMacSignature(executable, { runCommand })
    if (observed.signer !== signature.signer || observed.teamId !== signature.teamId) {
      throw new Error('External Chrome native host Developer ID identity/team changed after staging')
    }
    return observed
  }
  if (platform === 'win32') {
    if (signature.scheme !== 'authenticode' || typeof signature.signer !== 'string' || signature.teamId !== null) {
      throw new Error('External Chrome Windows native host has invalid Authenticode signature metadata')
    }
    const observed = await inspectWindowsSignature(executable, { runCommand })
    if (observed.signer !== signature.signer) {
      throw new Error('External Chrome native host Authenticode signer changed after staging')
    }
    return observed
  }
  if (platform !== 'linux' || signature.scheme !== 'packaged-resource-hash' || signature.signer !== null || signature.teamId !== null) {
    throw new Error('External Chrome native host has invalid release-signature metadata')
  }
  const info = await stat(executable)
  if ((info.mode & 0o111) === 0) throw new Error('External Chrome Linux native host is not executable')
  return signature
}

export async function inspectMacSignature(executable, { runCommand = defaultRunCommand } = {}) {
  await runCommand('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', executable])
  const { stdout = '', stderr = '' } = await runCommand('/usr/bin/codesign', ['--display', '--verbose=4', executable])
  const detail = `${stdout}\n${stderr}`
  const signer = detail.match(/^Authority=(.+)$/mu)?.[1]?.trim() ?? null
  const teamId = detail.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() ?? null
  if (!signer?.startsWith('Developer ID Application: ') || !teamId) {
    throw new Error('External Chrome native host is not signed by a Developer ID Application identity with a team identifier')
  }
  return { signer, teamId }
}

export async function inspectWindowsSignature(executable, { runCommand = defaultRunCommand } = {}) {
  const escaped = executable.replaceAll("'", "''")
  const command = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    `[PSCustomObject]@{Status=$signature.Status.ToString();Subject=$signature.SignerCertificate.Subject;Thumbprint=$signature.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`,
  ].join('; ')
  const { stdout = '' } = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  let parsed
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new Error('External Chrome native host Authenticode inspection returned invalid output')
  }
  if (parsed.Status !== 'Valid' || typeof parsed.Subject !== 'string' || parsed.Subject.length === 0) {
    throw new Error(`External Chrome native host Authenticode signature is not valid (${String(parsed.Status)})`)
  }
  return { signer: parsed.Subject, thumbprint: typeof parsed.Thumbprint === 'string' ? parsed.Thumbprint : null }
}

async function defaultRunCommand(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 })
}

function requireEnvironment(env, names, label) {
  const missing = names.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`${label} requires ${missing.join(', ')}`)
}
