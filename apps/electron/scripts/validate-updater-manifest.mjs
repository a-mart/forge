#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function usage() {
  console.error(
    [
      'Usage: node apps/electron/scripts/validate-updater-manifest.mjs \\',
      '  --manifest PATH \\',
      '  --platform mac|windows \\',
      '  --version VERSION \\',
      '  --asset-root DIR \\',
      '  [--label TEXT]',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const args = {
    label: '[updater-manifest]',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      usage()
      throw new Error(`unexpected argument: ${arg}`)
    }

    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      usage()
      throw new Error(`missing value for --${key}`)
    }

    args[key] = value
    index += 1
  }

  if (!args.manifest || !args.platform || !args.version || !args['asset-root']) {
    usage()
    throw new Error('missing required arguments')
  }

  if (args.platform !== 'mac' && args.platform !== 'windows') {
    usage()
    throw new Error(`unsupported platform: ${args.platform}`)
  }

  return args
}

function fail(label, message) {
  console.error(`${label} ${message}`)
  process.exit(1)
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function sha512Base64(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64')
}

function manifestExpectations(platform, version) {
  if (platform === 'mac') {
    const zipName = `Forge-${version}-arm64-mac.zip`
    const dmgName = `Forge-${version}-arm64.dmg`
    return {
      primaryAssetName: zipName,
      allowedManifestAssetNames: new Set([zipName, dmgName]),
    }
  }

  const installerName = `Forge-Setup-${version}.exe`
  return {
    primaryAssetName: installerName,
    allowedManifestAssetNames: new Set([installerName]),
  }
}

function verifyFileReference({
  assetRoot,
  label,
  context,
  relativeFile,
  expectedSha512,
  allowedManifestAssetNames,
}) {
  if (!relativeFile) {
    fail(label, `${context} is missing a referenced filename`)
  }
  if (!expectedSha512) {
    fail(label, `${context} is missing sha512 metadata`)
  }

  const assetName = path.basename(relativeFile)
  if (!allowedManifestAssetNames.has(assetName)) {
    fail(label, `${context} references unexpected asset ${assetName}`)
  }

  const assetPath = path.join(assetRoot, assetName)
  if (!fs.existsSync(assetPath)) {
    fail(label, `${context} references missing asset ${assetName}`)
  }

  const actualSha512 = sha512Base64(assetPath)
  if (actualSha512 !== expectedSha512) {
    fail(
      label,
      `${context} sha512 mismatch for ${assetName}: expected ${expectedSha512}, found ${actualSha512}`,
    )
  }

  return assetName
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[updater-manifest] ${error.message}`)
    process.exit(1)
  }

  const label = args.label
  const manifestPath = path.resolve(args.manifest)
  const assetRoot = path.resolve(args['asset-root'])
  const version = args.version
  const expectations = manifestExpectations(args.platform, version)

  if (!fs.existsSync(manifestPath)) {
    fail(label, `manifest not found: ${manifestPath}`)
  }
  if (!fs.existsSync(assetRoot)) {
    fail(label, `asset root not found: ${assetRoot}`)
  }

  const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/)
  let manifestVersion = null
  let topLevelPath = null
  let topLevelSha512 = null
  let currentFile = null
  const fileEntries = []

  for (const line of lines) {
    let match

    if ((match = line.match(/^version:\s*(.+?)\s*$/))) {
      manifestVersion = unquote(match[1])
      continue
    }

    if ((match = line.match(/^path:\s*(.+?)\s*$/))) {
      topLevelPath = unquote(match[1])
      continue
    }

    if ((match = line.match(/^sha512:\s*(.+?)\s*$/))) {
      topLevelSha512 = unquote(match[1])
      continue
    }

    if ((match = line.match(/^\s*-\s*url:\s*(.+?)\s*$/))) {
      currentFile = { url: unquote(match[1]) }
      fileEntries.push(currentFile)
      continue
    }

    if ((match = line.match(/^\s+sha512:\s*(.+?)\s*$/))) {
      if (currentFile) {
        currentFile.sha512 = unquote(match[1])
      }
    }
  }

  if (manifestVersion !== version) {
    fail(label, `version mismatch: expected ${version}, found ${manifestVersion ?? '<missing>'}`)
  }

  if (fileEntries.length === 0) {
    fail(label, 'does not contain any files[] entries')
  }

  const referencedPrimaryEntries = []
  const seenFileEntryNames = new Set()

  for (const entry of fileEntries) {
    const assetName = verifyFileReference({
      assetRoot,
      label,
      context: `${path.basename(manifestPath)} files[] entry`,
      relativeFile: entry.url,
      expectedSha512: entry.sha512,
      allowedManifestAssetNames: expectations.allowedManifestAssetNames,
    })

    if (seenFileEntryNames.has(assetName)) {
      fail(label, `contains duplicate files[] entry for ${assetName}`)
    }
    seenFileEntryNames.add(assetName)

    if (assetName === expectations.primaryAssetName) {
      referencedPrimaryEntries.push(entry)
    }
  }

  if (referencedPrimaryEntries.length !== 1) {
    fail(
      label,
      `must reference the expected primary updater payload exactly once in files[]: ${expectations.primaryAssetName}`,
    )
  }

  if (topLevelPath || topLevelSha512) {
    if (!topLevelPath || !topLevelSha512) {
      fail(label, 'must contain both top-level path and sha512 when either is present')
    }

    const topLevelAssetName = verifyFileReference({
      assetRoot,
      label,
      context: `${path.basename(manifestPath)} top-level path`,
      relativeFile: topLevelPath,
      expectedSha512: topLevelSha512,
      allowedManifestAssetNames: expectations.allowedManifestAssetNames,
    })

    if (topLevelAssetName !== expectations.primaryAssetName) {
      fail(
        label,
        `top-level path must point at the expected primary updater payload ${expectations.primaryAssetName}, found ${topLevelAssetName}`,
      )
    }
  }

  console.log(
    `${label} Validated ${path.basename(manifestPath)} for ${args.platform} ${version} (primary payload: ${expectations.primaryAssetName})`,
  )
}

main()
