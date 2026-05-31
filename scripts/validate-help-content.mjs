#!/usr/bin/env node
/**
 * Static help-content validator. Parses TS sources from disk only — does not
 * import app modules or run through Vite/HMR.
 *
 * Permanent validation (`pnpm help:validate`, `--strict`):
 * - Every article uses a raw Markdown import (no template-literal bodies)
 * - Import paths, referenced bodies, graph/metadata/tooltip integrity, Markdown hygiene
 * - Does not require `.internal/help-content-baseline.json`
 *
 * Migration fidelity (`pnpm help:validate:migration`, `--strict --fidelity`):
 * - Compares current articles against a provenance-safe pre-migration baseline
 * - Requires baseline from unmigrated TS template literals (see pnpm help:baseline)
 * - Optional `--baseline <path>` (default: .internal/help-content-baseline.json)
 *
 * Legacy mixed mode (`--mixed` or no mode flag): partial migration tolerance; not used
 * by package scripts or local quality.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const HELP_CONTENT_DIR = path.join(
  REPO_ROOT,
  'apps/ui/src/components/help/content',
)
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  'apps/ui/src/components/help/help-registry.ts',
)
const TOOLTIPS_PATH = path.join(HELP_CONTENT_DIR, 'tooltips.ts')
const ARTICLES_ROOT = path.join(HELP_CONTENT_DIR, 'articles')

const ARTICLE_MODULE_FILES = [
  'getting-started.ts',
  'chat-articles.ts',
  'settings-articles.ts',
  'cortex-articles.ts',
  'models-articles.ts',
  'concepts-articles.ts',
  'terminal-articles.ts',
]

const VALID_CATEGORIES = new Set([
  'getting-started',
  'chat',
  'settings',
  'cortex',
  'models',
  'concepts',
  'terminals',
])

const CAPTURE_POLICY_UNMIGRATED = 'unmigrated_ts_template_literals_only'
const CAPTURE_POLICY_MIGRATED = 'includes_migrated_raw_md_imports'

const args = process.argv.slice(2)
const runFidelity = args.includes('--fidelity')
const mode = args.includes('--mixed')
  ? 'mixed'
  : args.includes('--strict') || runFidelity
    ? 'strict'
    : 'mixed'

const defaultBaselinePath = path.join(REPO_ROOT, '.internal/help-content-baseline.json')
let fidelityBaselinePath = defaultBaselinePath
const baselineFlagIndex = args.indexOf('--baseline')
if (baselineFlagIndex !== -1) {
  const baselineArg = args[baselineFlagIndex + 1]
  if (!baselineArg || baselineArg.startsWith('--')) {
    console.error('ERROR: --baseline requires a file path')
    process.exit(1)
  }
  fidelityBaselinePath = path.isAbsolute(baselineArg)
    ? baselineArg
    : path.resolve(REPO_ROOT, baselineArg)
}

const errors = []
const warnings = []

function fail(message) {
  errors.push(message)
}

function warn(message) {
  warnings.push(message)
}

function assertRegistryMatchesExpectedModules() {
  const registrySource = fs.readFileSync(REGISTRY_PATH, 'utf8')
  for (const file of ARTICLE_MODULE_FILES) {
    const stem = file.replace('.ts', '')
    if (!registrySource.includes(stem)) {
      fail(`help-registry.ts no longer references ${file}; update validator module list`)
    }
  }
}

function parseSourceFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function getPropertyName(name) {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text
  }
  return null
}

function getStringLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  return null
}

function isTemplateLiteralContent(node) {
  return (
    ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
  )
}

function getRawImports(sourceFile) {
  const imports = new Map()

  sourceFile.forEachChild(function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier
      if (!ts.isStringLiteral(specifier)) return
      if (!specifier.text.endsWith('.md?raw')) return
      const clause = node.importClause
      if (!clause?.name) return
      imports.set(clause.name.text, specifier.text)
    }
    ts.forEachChild(node, visit)
  })

  return imports
}

function extractArticlesFromModule(filePath) {
  const sourceFile = parseSourceFile(filePath)
  const rawImports = getRawImports(sourceFile)
  const identifierArticles = new Map()
  const articles = []

  function visit(node) {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length === 1
    ) {
      const declaration = node.declarationList.declarations[0]
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        const typeNode = declaration.type
        const isHelpArticle =
          typeNode &&
          ts.isTypeReferenceNode(typeNode) &&
          ts.isIdentifier(typeNode.typeName) &&
          typeNode.typeName.text === 'HelpArticle'

        if (isHelpArticle) {
          identifierArticles.set(
            declaration.name.text,
            parseArticleObject(declaration.initializer, rawImports, filePath),
          )
        }
      }
    }

    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !declaration.initializer ||
          !ts.isArrayLiteralExpression(declaration.initializer)
        ) {
          continue
        }

        for (const element of declaration.initializer.elements) {
          if (ts.isObjectLiteralExpression(element)) {
            articles.push(parseArticleObject(element, rawImports, filePath))
          } else if (ts.isIdentifier(element)) {
            const referenced = identifierArticles.get(element.text)
            if (!referenced) {
              fail(`${filePath}: unresolved HelpArticle identifier "${element.text}"`)
            } else {
              articles.push(referenced)
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { articles, rawImports, sourceFile }
}

function parseArticleObject(objectLiteral, rawImports, filePath) {
  const article = {
    id: null,
    title: null,
    category: null,
    summary: null,
    contentKind: null,
    contentImport: null,
    keywords: [],
    relatedIds: [],
    contextKeys: [],
  }

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const key = getPropertyName(property.name)
    if (!key) continue
    const initializer = property.initializer

    if (key === 'id' || key === 'category' || key === 'title' || key === 'summary') {
      article[key] = getStringLiteralValue(initializer)
      continue
    }

    if (key === 'content') {
      if (isTemplateLiteralContent(initializer)) {
        article.contentKind = 'template'
      } else if (ts.isIdentifier(initializer)) {
        article.contentKind = 'import'
        article.contentImport = initializer.text
      } else {
        article.contentKind = 'other'
      }
      continue
    }

    if (key === 'keywords' || key === 'relatedIds' || key === 'contextKeys') {
      if (!ts.isArrayLiteralExpression(initializer)) continue
      article[key] = initializer.elements
        .map((element) => getStringLiteralValue(element))
        .filter((value) => value != null)
    }
  }

  return article
}

function validateRawImportPath(filePath, article, importPath, importName) {
  const expectedSuffix = `./articles/${article.category}/${article.id}.md?raw`
  if (importPath !== expectedSuffix) {
    fail(
      `${filePath}: ${article.id} raw import "${importPath}" expected "${expectedSuffix}"`,
    )
  }

  const mdPath = path.resolve(
    path.dirname(filePath),
    importPath.replace(/\?raw$/, ''),
  )
  if (!fs.existsSync(mdPath)) {
    fail(`${filePath}: missing Markdown body at ${mdPath}`)
  }
}

function validateModuleShape(filePath, moduleData) {
  const relativePath = path.relative(REPO_ROOT, filePath)
  const { articles, rawImports } = moduleData
  const hasRawImports = rawImports.size > 0
  const enforceRawOnly = mode === 'strict' || hasRawImports

  for (const article of articles) {
    if (!article.id) {
      fail(`${relativePath}: article missing id`)
      continue
    }

    if (!article.category || !VALID_CATEGORIES.has(article.category)) {
      fail(`${relativePath}: ${article.id} has invalid category "${article.category}"`)
    }

    if (!article.title) {
      fail(`${relativePath}: ${article.id} must have a title`)
    }

    if (!article.summary) {
      fail(`${relativePath}: ${article.id} must have a summary`)
    }

    if (!article.keywords?.length) {
      fail(`${relativePath}: ${article.id} must have non-empty keywords`)
    }

    if (!article.contextKeys?.length) {
      fail(`${relativePath}: ${article.id} must have non-empty contextKeys`)
    }

    if (article.contentKind === 'template') {
      if (enforceRawOnly) {
        fail(
          `${relativePath}: ${article.id} still uses a template-literal content body`,
        )
      }
      continue
    }

    if (article.contentKind !== 'import') {
      fail(`${relativePath}: ${article.id} content must be a raw Markdown import identifier`)
      continue
    }

    const importPath = rawImports.get(article.contentImport)
    if (!importPath) {
      fail(
        `${relativePath}: ${article.id} references unknown import "${article.contentImport}"`,
      )
      continue
    }

    validateRawImportPath(filePath, article, importPath, article.contentImport)
  }

  for (const [importName, importPath] of rawImports.entries()) {
    const used = articles.some((article) => article.contentImport === importName)
    if (!used) {
      fail(`${relativePath}: unused raw import "${importName}" from "${importPath}"`)
    }
  }
}

function findMarkdownFiles(dir) {
  const results = []
  if (!fs.existsSync(dir)) return results

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath)
    }
  }

  return results
}

function validateMarkdownFile(filePath, referencedPaths) {
  const relativePath = path.relative(REPO_ROOT, filePath)
  const text = fs.readFileSync(filePath, 'utf8')
  const trimmed = text.trim()

  if (!trimmed) {
    fail(`${relativePath}: Markdown body is empty`)
    return
  }

  if (trimmed.startsWith('---')) {
    fail(`${relativePath}: frontmatter is not supported in v1`)
  }

  if (!referencedPaths.has(filePath)) {
    fail(`${relativePath}: Markdown file is not referenced by any article raw import`)
  }

  if (/\\`/.test(text)) {
    warn(
      `${relativePath}: contains escaped backticks; verify TS copy was de-escaped`,
    )
  }

  validateNoTopLevelH1(text, relativePath)
}

function validateNoTopLevelH1(text, relativePath) {
  let inFence = false

  for (const line of text.split('\n')) {
    const trimmedLine = line.trim()

    if (trimmedLine.startsWith('```')) {
      inFence = !inFence
      continue
    }

    if (inFence) continue

    if (/^#[^#]/.test(trimmedLine)) {
      fail(`${relativePath}: top-level H1 headings are not allowed (${trimmedLine})`)
    }
  }
}

function validateTooltips(articleIds) {
  const sourceFile = parseSourceFile(TOOLTIPS_PATH)

  sourceFile.forEachChild(function visit(node) {
    if (
      !ts.isVariableStatement(node) ||
      !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      ts.forEachChild(node, visit)
      return
    }

    for (const declaration of node.declarationList.declarations) {
      if (
        !declaration.initializer ||
        !ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        continue
      }

      for (const element of declaration.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue

        let articleId = null
        for (const property of element.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          const key = getPropertyName(property.name)
          if (key === 'articleId') {
            articleId = getStringLiteralValue(property.initializer)
          }
        }

        if (articleId && !articleIds.has(articleId)) {
          fail(`tooltips.ts: articleId "${articleId}" does not match any help article`)
        }
      }
    }

    ts.forEachChild(node, visit)
  })
}

function validateBaselineProvenance(baseline) {
  if (!baseline.provenance || typeof baseline.provenance !== 'object') {
    fail(
      'Fidelity: baseline missing provenance metadata; regenerate with `pnpm help:baseline` from unmigrated TS template literals before migration',
    )
    return false
  }

  const { capturePolicy, contentSourceCounts } = baseline.provenance

  if (capturePolicy === CAPTURE_POLICY_MIGRATED) {
    fail(
      'Fidelity: baseline capturePolicy includes migrated raw .md imports (tautological); regenerate from unmigrated TS template literals with `pnpm help:baseline`',
    )
    return false
  }

  if (capturePolicy !== CAPTURE_POLICY_UNMIGRATED) {
    fail(
      `Fidelity: unsupported baseline capturePolicy "${String(capturePolicy)}"; regenerate with \`pnpm help:baseline\``,
    )
    return false
  }

  if (contentSourceCounts?.raw_md_import > 0) {
    fail(
      'Fidelity: baseline contentSourceCounts include raw_md_import entries; regenerate from unmigrated TS template literals',
    )
    return false
  }

  return true
}

const FIDELITY_METADATA_FIELDS = [
  'title',
  'category',
  'summary',
  'keywords',
  'relatedIds',
  'contextKeys',
]

function sortedStringArray(values) {
  return [...(values ?? [])].sort()
}

function normalizeFidelityMetadata(metadata) {
  return {
    title: metadata.title ?? null,
    category: metadata.category ?? null,
    summary: metadata.summary ?? null,
    keywords: sortedStringArray(metadata.keywords),
    relatedIds: sortedStringArray(metadata.relatedIds),
    contextKeys: sortedStringArray(metadata.contextKeys),
  }
}

function compareFidelityMetadata(articleId, baselineMetadata, currentMetadata) {
  const baseline = normalizeFidelityMetadata(baselineMetadata)
  const current = normalizeFidelityMetadata(currentMetadata)

  for (const field of FIDELITY_METADATA_FIELDS) {
    const expected = baseline[field]
    const actual = current[field]

    if (Array.isArray(expected)) {
      const expectedJson = JSON.stringify(expected)
      const actualJson = JSON.stringify(actual)
      if (expectedJson !== actualJson) {
        fail(
          `Fidelity: ${articleId} metadata.${field} drifted from baseline (expected ${expectedJson}, got ${actualJson})`,
        )
      }
      continue
    }

    if (expected !== actual) {
      fail(
        `Fidelity: ${articleId} metadata.${field} drifted from baseline (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
      )
    }
  }
}

function compareArticleFidelity(allArticles, baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    fail(
      `Fidelity: baseline file not found at ${path.relative(REPO_ROOT, baselinePath)}; capture provenance-safe baseline with pnpm help:baseline before migration fidelity validation`,
    )
    return
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  if (!validateBaselineProvenance(baseline)) {
    return
  }

  const currentById = new Map()
  for (const { article } of allArticles) {
    if (!article.id) continue
    currentById.set(article.id, article)
  }

  const baselineById = new Map()
  for (const entry of baseline.articles) {
    const entryId = entry.id ?? entry.metadata?.id
    if (!entryId) {
      fail('Fidelity: baseline contains an article without id')
      continue
    }
    baselineById.set(entryId, entry)
  }

  for (const baselineId of baselineById.keys()) {
    if (!currentById.has(baselineId)) {
      fail(
        `Fidelity: baseline article "${baselineId}" has no matching current article`,
      )
    }
  }

  for (const currentId of currentById.keys()) {
    if (!baselineById.has(currentId)) {
      fail(
        `Fidelity: current article "${currentId}" is missing from provenance-safe baseline`,
      )
    }
  }

  for (const [articleId, entry] of baselineById.entries()) {
    const current = currentById.get(articleId)
    if (!current) continue

    if (!entry.contentSource) {
      fail(
        `Fidelity: baseline entry ${articleId} missing contentSource; regenerate baseline from unmigrated TS template literals`,
      )
      continue
    }

    if (entry.contentSource !== 'template_literal') {
      fail(
        `Fidelity: baseline entry ${articleId} was captured from "${entry.contentSource}", not unmigrated TS template literals`,
      )
      continue
    }

    if (!entry.metadata) {
      fail(`Fidelity: baseline entry ${articleId} missing metadata`)
      continue
    }

    compareFidelityMetadata(articleId, entry.metadata, current)

    const category = entry.metadata.category ?? current.category
    if (!category) {
      fail(`Fidelity: ${articleId} missing category for body comparison`)
      continue
    }

    const mdPath = path.join(ARTICLES_ROOT, category, `${articleId}.md`)
    if (!fs.existsSync(mdPath)) {
      fail(`Fidelity: missing migrated body for ${articleId}`)
      continue
    }

    const migrated = fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    const expected = entry.normalizedContent.replace(/\n$/, '')

    if (migrated !== expected) {
      fail(
        `Fidelity: ${articleId} migrated Markdown does not match baseline normalized content`,
      )
    }
  }
}

function main() {
  assertRegistryMatchesExpectedModules()

  const articleIds = new Set()
  const referencedMdPaths = new Set()
  const allArticles = []

  for (const file of ARTICLE_MODULE_FILES) {
    const filePath = path.join(HELP_CONTENT_DIR, file)
    const moduleData = extractArticlesFromModule(filePath)
    validateModuleShape(filePath, moduleData)

    for (const article of moduleData.articles) {
      if (!article.id) continue
      if (articleIds.has(article.id)) {
        fail(`Duplicate article id "${article.id}"`)
      }
      articleIds.add(article.id)

      if (article.contentKind === 'import' && article.category) {
        const importPath = moduleData.rawImports.get(article.contentImport)
        if (importPath) {
          referencedMdPaths.add(
            path.resolve(path.dirname(filePath), importPath.replace(/\?raw$/, '')),
          )
        }
      }

      for (const relatedId of article.relatedIds ?? []) {
        if (!articleIds.has(relatedId)) {
          // defer until all ids collected
        }
      }

      allArticles.push({ filePath, article })
    }
  }

  for (const { article } of allArticles) {
    for (const relatedId of article.relatedIds ?? []) {
      if (!articleIds.has(relatedId)) {
        fail(`${article.id}: relatedIds references unknown article "${relatedId}"`)
      }
    }
  }

  validateTooltips(articleIds)

  for (const mdPath of findMarkdownFiles(ARTICLES_ROOT)) {
    validateMarkdownFile(mdPath, referencedMdPaths)
  }

  if (runFidelity) {
    compareArticleFidelity(allArticles, fidelityBaselinePath)
  }

  for (const message of warnings) {
    console.warn(`WARN: ${message}`)
  }

  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`ERROR: ${message}`)
    }
    const scope = runFidelity ? 'structural+fidelity' : 'structural'
    console.error(
      `\nHelp content validation failed (${errors.length} error(s), mode=${mode}, scope=${scope}).`,
    )
    process.exit(1)
  }

  const scope = runFidelity ? 'structural+fidelity' : 'structural'
  console.log(
    `Help content validation passed (${articleIds.size} articles, mode=${mode}, scope=${scope}).`,
  )
}

main()
