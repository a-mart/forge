import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { endianness } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertSeaToolchain,
  prepareExecutableForInitialSmoke,
  prepareReleaseExecutable,
  SEA_NODE_VERSION,
} from './release-signing.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'sea-config.json')
const nativeProtocol = { min: 1, max: 1, maxMessageBytes: 1_048_576 }
const origin = 'chrome-extension://fcchfcnadajoejfbiclihglkmbcfhajd/'

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function smoke(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    input: Buffer.alloc(0),
    maxBuffer: 64 * 1_024,
  })
  if (result.status !== 1) throw new Error(`host smoke returned ${String(result.status)}: ${result.stderr.toString('utf8')}`)
  const output = result.stdout
  if (output.byteLength < 5) throw new Error('host smoke did not emit a native message')
  const payloadLength = endianness() === 'LE' ? output.readUInt32LE(0) : output.readUInt32BE(0)
  if (payloadLength !== output.byteLength - 4) throw new Error('host smoke emitted malformed or extra stdout bytes')
  const message = JSON.parse(output.subarray(4).toString('utf8'))
  if (message?.type !== 'desktop-unavailable') throw new Error('host smoke emitted an unexpected response')
}

export async function prepareAndSmokeExecutable(executable, arguments_, {
  platform = process.platform,
  runCommand,
  smokeExecutable = smoke,
  prepareRelease = prepareReleaseExecutable,
} = {}) {
  await prepareExecutableForInitialSmoke(executable, { platform, runCommand })
  smokeExecutable(executable, arguments_)
  const signature = await prepareRelease(executable, { platform, runCommand })
  smokeExecutable(executable, arguments_)
  return signature
}

/** The direct --build-sea result is the capability gate for validation packaging. */
export function inspectSeaBuildCapability(result, { nodeVersion = process.versions.node } = {}) {
  if (result.status === 0) return { supported: true }

  const detail = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim()
  const reason = detail.includes('NODE_SEA_FUSE')
    ? `Node ${nodeVersion} executable lacks the NODE_SEA_FUSE sentinel required by --build-sea`
    : `SEA build failed: ${detail || 'Node did not return a build result'}`
  return { supported: false, reason }
}

export async function packageCurrent() {
  assertSeaToolchain()
  const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const executableName = process.platform === 'win32'
    ? 'forge-external-chrome-native-host.exe'
    : 'forge-external-chrome-native-host'
  const executablePath = path.join(root, 'dist', executableName)
  const currentConfigPath = path.join(root, 'dist', 'sea-config.current.json')
  const platformArguments = [origin, ...(process.platform === 'win32' ? ['--parent-window=0'] : [])]

  smoke(process.execPath, [path.join(root, 'dist', 'host.cjs'), ...platformArguments])
  const seaConfig = JSON.parse(await readFile(configPath, 'utf8'))
  seaConfig.output = `dist/${executableName}`
  await writeFile(currentConfigPath, `${stable(seaConfig)}\n`, { mode: 0o644 })
  const result = spawnSync(process.execPath, [`--build-sea=${currentConfigPath}`], {
    cwd: root,
    encoding: 'utf8',
  })
  const seaCapability = inspectSeaBuildCapability(result)
  if (!seaCapability.supported) {
    const manifest = {
      schemaVersion: 1,
      package: '@forge/external-chrome-native-host',
      version: packageMetadata.version,
      nativeProtocol,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.versions.node,
      bundle: { file: 'dist/host.cjs', sha256: await sha256(path.join(root, 'dist', 'host.cjs')) },
      bundleSmoke: 'desktop-unavailable',
      sea: {
        status: 'unsupported-toolchain',
        reason: seaCapability.reason,
        config: 'dist/sea-config.current.json',
        configSha256: await sha256(currentConfigPath),
      },
    }
    await writeFile(path.join(root, 'dist', 'package-manifest.json'), `${stable(manifest)}\n`, { mode: 0o644 })
    throw new Error(
      `${seaCapability.reason}; validation packaging requires a Node executable with direct --build-sea support, ` +
      `while release packaging is pinned to official Node ${SEA_NODE_VERSION}`,
    )
  }
  if (process.platform !== 'win32') await chmod(executablePath, 0o755)

  // macOS refuses to execute the unsigned --build-sea output, so give it an
  // ad-hoc signature before the first smoke. macOS release mode replaces that
  // signature with its required verified identity; Windows remains explicitly
  // unsigned and is protected by the authoritative manifest hash.
  const signature = await prepareAndSmokeExecutable(executablePath, platformArguments)

  const manifest = {
    schemaVersion: 1,
    package: '@forge/external-chrome-native-host',
    version: packageMetadata.version,
    nativeProtocol,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
    executable: {
      file: `dist/${executableName}`,
      sha256: await sha256(executablePath),
      signature,
    },
    bundle: {
      file: 'dist/host.cjs',
      sha256: await sha256(path.join(root, 'dist', 'host.cjs')),
    },
    seaConfig: {
      file: 'dist/sea-config.current.json',
      sha256: await sha256(currentConfigPath),
    },
    smoke: 'desktop-unavailable',
  }
  await writeFile(path.join(root, 'dist', 'package-manifest.json'), `${stable(manifest)}\n`, { mode: 0o644 })
  process.stdout.write(`${manifest.executable.sha256}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageCurrent().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
