import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const protocolDistPath = path.join(repoRoot, 'packages', 'protocol', 'dist', 'index.js')
const piAiEntryPath = await findFirstReadable([
  path.join(repoRoot, 'apps', 'backend', 'node_modules', '@mariozechner', 'pi-ai', 'dist', 'index.js'),
  path.join(repoRoot, 'node_modules', '@mariozechner', 'pi-ai', 'dist', 'index.js'),
])

await assertReadable(
  protocolDistPath,
  'Protocol dist output not found. Run `pnpm --filter @forge/protocol build` before auditing.',
)

if (!piAiEntryPath) {
  throw new Error('Pi AI package not found. Run `pnpm install` first.')
}

const [{ FORGE_MODEL_CATALOG }, { getModels, getProviders }] = await Promise.all([
  import(pathToFileURL(protocolDistPath).href),
  import(pathToFileURL(piAiEntryPath).href),
])

const curatedProviders = Object.values(FORGE_MODEL_CATALOG.providers)
  .filter((provider) => provider.piProjectionMode !== 'none')
  .sort((a, b) => a.providerId.localeCompare(b.providerId))
const upstreamProviders = new Set(getProviders())

const missingProviders = curatedProviders
  .map((provider) => provider.providerId)
  .filter((providerId) => !upstreamProviders.has(providerId))

const missingUpstream = []
const uncuratedUpstream = []
const metadataDrift = []
const intentionalDivergences = []

for (const provider of curatedProviders) {
  if (!upstreamProviders.has(provider.providerId)) {
    continue
  }

  const upstreamModels = getModels(provider.providerId)
  const upstreamById = new Map(upstreamModels.map((model) => [model.id, model]))
  const curatedModels = Object.values(FORGE_MODEL_CATALOG.models)
    .filter((model) => model.provider === provider.providerId)
    .sort((a, b) => a.modelId.localeCompare(b.modelId))
  const curatedUpstreamIds = new Set(
    curatedModels
      .map((model) => model.piUpstreamId)
      .filter((modelId) => typeof modelId === 'string' && modelId.length > 0),
  )

  for (const model of curatedModels) {
    if (!model.piUpstreamId) {
      if (model.intentionalDivergenceNotes) {
        intentionalDivergences.push({
          providerId: provider.providerId,
          modelId: model.modelId,
          piUpstreamId: model.piUpstreamId,
          notes: model.intentionalDivergenceNotes,
        })
      }
      continue
    }

    const upstream = upstreamById.get(model.piUpstreamId)
    if (!upstream) {
      missingUpstream.push({
        providerId: provider.providerId,
        modelId: model.modelId,
        piUpstreamId: model.piUpstreamId,
      })
      continue
    }

    const fieldDiffs = []
    if (model.contextWindow !== upstream.contextWindow) {
      fieldDiffs.push({
        field: 'contextWindow',
        catalog: model.contextWindow,
        upstream: upstream.contextWindow,
      })
    }
    if (model.maxOutputTokens !== upstream.maxTokens) {
      fieldDiffs.push({
        field: 'maxOutputTokens',
        catalog: model.maxOutputTokens,
        upstream: upstream.maxTokens,
      })
    }
    if (model.supportsReasoning !== upstream.reasoning) {
      fieldDiffs.push({
        field: 'supportsReasoning',
        catalog: model.supportsReasoning,
        upstream: upstream.reasoning,
      })
    }

    const normalizedCatalogInputModes = normalizeStringArray(model.inputModes)
    const normalizedUpstreamInputModes = normalizeStringArray(upstream.input ?? [])
    if (!stringArraysEqual(normalizedCatalogInputModes, normalizedUpstreamInputModes)) {
      fieldDiffs.push({
        field: 'inputModes',
        catalog: normalizedCatalogInputModes,
        upstream: normalizedUpstreamInputModes,
      })
    }

    if (model.intentionalDivergenceNotes) {
      intentionalDivergences.push({
        providerId: provider.providerId,
        modelId: model.modelId,
        piUpstreamId: model.piUpstreamId,
        notes: model.intentionalDivergenceNotes,
        ...(fieldDiffs.length > 0 ? { diffs: fieldDiffs } : {}),
      })
      continue
    }

    if (fieldDiffs.length > 0) {
      metadataDrift.push({
        providerId: provider.providerId,
        modelId: model.modelId,
        piUpstreamId: model.piUpstreamId,
        diffs: fieldDiffs,
      })
    }
  }

  for (const upstream of upstreamModels.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (!curatedUpstreamIds.has(upstream.id)) {
      uncuratedUpstream.push({
        providerId: provider.providerId,
        modelId: upstream.id,
        displayName: upstream.name,
      })
    }
  }
}

const status =
  missingProviders.length > 0 || missingUpstream.length > 0 || metadataDrift.length > 0
    ? 'fail'
    : uncuratedUpstream.length > 0
      ? 'warn'
      : 'pass'

const report = {
  generatedAt: new Date().toISOString(),
  status,
  curatedProviders: curatedProviders.map((provider) => ({
    providerId: provider.providerId,
    displayName: provider.displayName,
    projectionScope: provider.projectionScope,
  })),
  upstreamProviders: [...upstreamProviders].sort(),
  missingProviders,
  missingUpstream,
  uncuratedUpstream,
  metadataDrift,
  intentionalDivergences,
  summary: {
    curatedProviderCount: curatedProviders.length,
    upstreamProviderCount: upstreamProviders.size,
    missingProviderCount: missingProviders.length,
    missingUpstreamCount: missingUpstream.length,
    uncuratedUpstreamCount: uncuratedUpstream.length,
    metadataDriftCount: metadataDrift.length,
    intentionalDivergenceCount: intentionalDivergences.length,
  },
}

console.log(JSON.stringify(report, null, 2))
console.log('')
console.log(`Forge model catalog audit: ${status.toUpperCase()}`)
console.log(`- curated providers checked: ${report.summary.curatedProviderCount}`)
console.log(`- missing providers: ${report.summary.missingProviderCount}`)
console.log(`- missing upstream models: ${report.summary.missingUpstreamCount}`)
console.log(`- uncurated upstream models: ${report.summary.uncuratedUpstreamCount}`)
console.log(`- metadata drift entries: ${report.summary.metadataDriftCount}`)
console.log(`- intentional divergences: ${report.summary.intentionalDivergenceCount}`)

if (missingProviders.length > 0) {
  console.log(`Missing providers: ${missingProviders.join(', ')}`)
}

if (missingUpstream.length > 0) {
  console.log(
    `Missing upstream models: ${missingUpstream
      .map((entry) => `${entry.providerId}:${entry.modelId}`)
      .join(', ')}`,
  )
}

if (metadataDrift.length > 0) {
  console.log(
    `Metadata drift: ${metadataDrift
      .map((entry) => `${entry.providerId}:${entry.modelId}`)
      .join(', ')}`,
  )
}

if (uncuratedUpstream.length > 0) {
  console.log(
    `Uncurated upstream examples: ${uncuratedUpstream
      .slice(0, 10)
      .map((entry) => `${entry.providerId}:${entry.modelId}`)
      .join(', ')}`,
  )
}

function normalizeStringArray(values) {
  return [...values].map(String).sort((a, b) => a.localeCompare(b))
}

function stringArraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function findFirstReadable(paths) {
  for (const candidate of paths) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // keep trying candidates
    }
  }

  return null
}

async function assertReadable(targetPath, message) {
  try {
    await access(targetPath)
  } catch {
    throw new Error(message)
  }
}
