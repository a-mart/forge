import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createPackageManifest } from './package-manifest.mjs'
import { hashTree, sha256, stableJson } from './deterministic.mjs'
import { verifyIdentity } from './verify-identity.mjs'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv.indexOf('--out-dir')
const packageRoot = path.resolve(outputArgument === -1 ? path.join(sourceRoot, 'dist') : process.argv[outputArgument + 1])
const extensionRoot = path.join(packageRoot, 'extension')
const temporaryPayload = path.join(packageRoot, '.payload')
// Keep in lockstep with src/runtime/identity.ts; the payload validates its own immutable directory.
const payloadVersion = 'm5-runtime.1'

async function bundle(entry, outfile, options = {}) {
  await mkdir(path.dirname(outfile), { recursive: true })
  await build({
    absWorkingDir: sourceRoot,
    bundle: true,
    charset: 'utf8',
    entryPoints: [entry],
    format: options.format ?? 'esm',
    ...(options.define === undefined ? {} : { define: options.define }),
    ...(options.globalName === undefined ? {} : { globalName: options.globalName }),
    legalComments: 'none',
    logLevel: 'silent',
    minify: false,
    outfile,
    platform: 'browser',
    sourcemap: false,
    target: ['chrome125'],
    treeShaking: true,
  })
  const normalized = (await readFile(outfile, 'utf8')).replace(/\r\n/g, '\n')
  if (normalized.includes(sourceRoot) || normalized.includes('sourceMappingURL=')) throw new Error(`non-reproducible build metadata in ${outfile}`)
  await writeFile(outfile, normalized.endsWith('\n') ? normalized : `${normalized}\n`, { mode: 0o644 })
}

async function bundleServiceWorkerBootstrap(payloadFile, outfile, define) {
  const shellFile = `${outfile}.shell`
  await bundle('src/shell/service-worker-bootstrap.ts', shellFile, { format: 'iife', define })
  const [payloadSource, shellSource] = await Promise.all([
    readFile(payloadFile, 'utf8'),
    readFile(shellFile, 'utf8'),
  ])
  const indent = (source) => source.split('\n').filter((line, index, lines) => index < lines.length - 1 || line !== '').map((line) => `    ${line}`).join('\n')
  const combined = [
    '(() => {',
    '  function loadBundledServiceWorkerPayload() {',
    indent(payloadSource),
    '    return ForgeExternalChromePayload;',
    '  }',
    indent(shellSource),
    '})();',
    '',
  ].join('\n')
  if (combined.includes(sourceRoot) || combined.includes('sourceMappingURL=')) throw new Error(`non-reproducible build metadata in ${outfile}`)
  await writeFile(outfile, combined, { mode: 0o644 })
  await rm(shellFile, { force: true })
}

await rm(packageRoot, { recursive: true, force: true })
await Promise.all([mkdir(path.join(extensionRoot, 'shell'), { recursive: true }), mkdir(temporaryPayload, { recursive: true })])
await verifyIdentity(sourceRoot)

await Promise.all([
  bundle('src/payload/service-worker/index.ts', path.join(temporaryPayload, 'service-worker.js'), { format: 'iife', globalName: 'ForgeExternalChromePayload' }),
  bundle('src/payload/content-script/index.ts', path.join(temporaryPayload, 'content-script.js'), { format: 'iife' }),
  bundle('src/payload/side-panel/index.ts', path.join(temporaryPayload, 'side-panel.js')),
])

const payloadFiles = Object.fromEntries(await Promise.all(
  ['content-script.js', 'service-worker.js', 'side-panel.js'].map(async (file) => [file, sha256(await readFile(path.join(temporaryPayload, file)))]),
))
const payloadSha256 = await hashTree(temporaryPayload)
const payloadDirectory = `${payloadVersion}-${payloadSha256}`
const finalPayload = path.join(extensionRoot, 'payloads', payloadDirectory)
await mkdir(path.dirname(finalPayload), { recursive: true })
await rename(temporaryPayload, finalPayload)

// Chromium MV3 does not support adding classic worker scripts after asynchronous
// selector verification. Bind the identity into the shell and embed the exact
// worker payload in a deferred static factory so Chrome parses it at install time
// but payload initialization cannot execute before verification.
const shellDefine = {
  FORGE_PAYLOAD_DIRECTORY: JSON.stringify(payloadDirectory),
  FORGE_SERVICE_WORKER_SHA256: JSON.stringify(payloadFiles['service-worker.js']),
}
await Promise.all([
  bundleServiceWorkerBootstrap(
    path.join(finalPayload, 'service-worker.js'),
    path.join(extensionRoot, 'shell/service-worker-bootstrap.js'),
    shellDefine,
  ),
  bundle('src/shell/side-panel-bootstrap.ts', path.join(extensionRoot, 'shell/side-panel-bootstrap.js'), { define: shellDefine }),
])

const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.shell.json'), 'utf8'))
await writeFile(path.join(extensionRoot, 'manifest.json'), stableJson(manifest), { mode: 0o644 })
await cp(path.join(sourceRoot, 'public/side-panel.html'), path.join(extensionRoot, 'shell/side-panel.html'))
await cp(path.join(sourceRoot, 'public/side-panel.css'), path.join(extensionRoot, 'shell/side-panel.css'))
for (const file of ['side-panel.html', 'side-panel.css']) {
  const destination = path.join(extensionRoot, 'shell', file)
  const normalized = (await readFile(destination, 'utf8')).replace(/\r\n/g, '\n')
  await writeFile(destination, normalized.endsWith('\n') ? normalized : `${normalized}\n`, { mode: 0o644 })
}
await writeFile(path.join(extensionRoot, 'current.json'), stableJson({
  schemaVersion: 1,
  shellAbi: 1,
  payloadVersion,
  payloadSha256,
  payloadDirectory,
  payloadFiles,
}), { mode: 0o644 })

const packageManifest = await createPackageManifest({ packageRoot, sourceRoot, payloadVersion, payloadSha256, payloadDirectory })
await writeFile(path.join(packageRoot, 'package-manifest.json'), stableJson(packageManifest), { mode: 0o644 })
for (const directory of [packageRoot, extensionRoot, path.join(extensionRoot, 'shell'), path.join(extensionRoot, 'payloads'), finalPayload]) {
  await chmod(directory, 0o755)
}
process.stdout.write(`${packageManifest.extension.treeSha256}\n`)
