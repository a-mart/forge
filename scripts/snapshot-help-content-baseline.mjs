#!/usr/bin/env node
/**
 * Capture a provenance-safe baseline of help article bodies from unmigrated TS sources.
 *
 * Default policy:
 * - Only template-literal article bodies (pre-migration TS sources).
 * - Refuses to overwrite an existing `.internal/help-content-baseline.json` unless `--force`.
 * - Refuses capture when any article already uses `.md?raw` imports unless
 *   `--allow-migrated-sources` is passed explicitly.
 *
 * Writes:
 *   { provenance, articles: [{ id, metadata, normalizedContent, contentSource }] }
 *
 * Local-only artifact — do not commit output under .internal/.
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.FORGE_REPO_ROOT
  ? path.resolve(process.env.FORGE_REPO_ROOT)
  : path.resolve(__dirname, '..')
const HELP_CONTENT_DIR = path.join(
  REPO_ROOT,
  'apps/ui/src/components/help/content',
)
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  'apps/ui/src/components/help/help-registry.ts',
)
const BASELINE_PATH = path.join(
  REPO_ROOT,
  '.internal/help-content-baseline.json',
)

const CAPTURE_POLICY_UNMIGRATED = 'unmigrated_ts_template_literals_only'
const CAPTURE_POLICY_MIGRATED = 'includes_migrated_raw_md_imports'

const ARTICLE_MODULE_IMPORTS = [
  { importName: 'gettingStartedArticles', file: 'getting-started.ts' },
  { importName: 'chatArticles', file: 'chat-articles.ts' },
  { importName: 'settingsArticles', file: 'settings-articles.ts' },
  { importName: 'cortexArticles', file: 'cortex-articles.ts' },
  { importName: 'modelsArticles', file: 'models-articles.ts' },
  { importName: 'conceptsArticles', file: 'concepts-articles.ts' },
  { importName: 'terminalArticles', file: 'terminal-articles.ts' },
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

const args = process.argv.slice(2)
const force = args.includes('--force')
const allowMigratedSources = args.includes('--allow-migrated-sources')

function getGitSha() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function assertRegistryMatchesExpectedModules() {
  const registrySource = fs.readFileSync(REGISTRY_PATH, 'utf8')
  for (const { importName, file } of ARTICLE_MODULE_IMPORTS) {
    if (!registrySource.includes(importName)) {
      throw new Error(
        `help-registry.ts no longer imports ${importName}; update snapshot module list`,
      )
    }
    if (!registrySource.includes(`./content/${file.replace('.ts', '')}`)) {
      throw new Error(
        `help-registry.ts no longer imports from ./content/${file}; update snapshot module list`,
      )
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

function getTemplateLiteralText(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text
    for (const span of node.templateSpans) {
      text += '${...}'
      text += span.literal.text
    }
    return text
  }
  return null
}

function normalizeTemplateContent(text) {
  return text.replace(/\\`/g, '`').replace(/\\\$\{/g, '${')
}

function extractMetadataFromObjectLiteral(objectLiteral) {
  const metadata = {}
  let normalizedContent = null
  let contentSource = null
  let contentImportName = null

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const key = getPropertyName(property.name)
    if (!key) continue

    const initializer = property.initializer

    if (key === 'content') {
      const templateText = getTemplateLiteralText(initializer)
      if (templateText != null) {
        normalizedContent = normalizeTemplateContent(templateText)
        contentSource = 'template_literal'
      } else if (ts.isIdentifier(initializer)) {
        contentSource = 'raw_md_import'
        contentImportName = initializer.text
      } else {
        contentSource = 'unsupported'
      }
      continue
    }

    if (key === 'keywords' || key === 'relatedIds' || key === 'contextKeys') {
      if (!ts.isArrayLiteralExpression(initializer)) continue
      metadata[key] = initializer.elements
        .map((element) => getStringLiteralValue(element))
        .filter((value) => value != null)
      continue
    }

    const stringValue = getStringLiteralValue(initializer)
    if (stringValue != null) {
      metadata[key] = stringValue
    }
  }

  return { metadata, normalizedContent, contentSource, contentImportName }
}

function collectArticlesFromSourceFile(sourceFile) {
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
          const extracted = extractMetadataFromObjectLiteral(
            declaration.initializer,
          )
          identifierArticles.set(declaration.name.text, extracted)
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
            articles.push(extractMetadataFromObjectLiteral(element))
          } else if (ts.isIdentifier(element)) {
            const referenced = identifierArticles.get(element.text)
            if (!referenced) {
              throw new Error(
                `Unresolved HelpArticle identifier "${element.text}" in ${sourceFile.fileName}`,
              )
            }
            articles.push(referenced)
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return articles
}

function getRawImports(sourceFile) {
  const rawImports = new Map()

  sourceFile.forEachChild(function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier
      if (!ts.isStringLiteral(specifier)) return
      if (!specifier.text.endsWith('.md?raw')) return
      const clause = node.importClause
      if (!clause?.name) return
      rawImports.set(clause.name.text, specifier.text)
    }
    ts.forEachChild(node, visit)
  })

  return rawImports
}

function normalizeMarkdownFileContent(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '')
}

function loadMarkdownBody(relativeImportPath, importingFile) {
  const mdPath = relativeImportPath.replace(/\?raw$/, '')
  const absolutePath = path.resolve(path.dirname(importingFile), mdPath)
  const raw = fs.readFileSync(absolutePath, 'utf8')
  return normalizeMarkdownFileContent(raw)
}

function resolveRawImportContent(sourceFile, importPath) {
  return loadMarkdownBody(importPath, sourceFile.fileName)
}

function materializeArticleContent(sourceFile, article, allowMigrated) {
  if (article.contentSource === 'template_literal') {
    return article.normalizedContent ?? ''
  }

  if (article.contentSource !== 'raw_md_import') {
    throw new Error(
      `Unsupported content source "${article.contentSource}" for article ${article.metadata.id ?? '(missing id)'}`,
    )
  }

  if (!allowMigrated) {
    return null
  }

  const rawImports = getRawImports(sourceFile)
  const importPath = rawImports.get(article.contentImportName)
  if (!importPath) {
    throw new Error(
      `Missing raw import for ${article.contentImportName} (${article.metadata.id})`,
    )
  }

  return resolveRawImportContent(sourceFile, importPath)
}

function main() {
  assertRegistryMatchesExpectedModules()

  if (fs.existsSync(BASELINE_PATH) && !force) {
    console.error(
      `Refusing to overwrite existing baseline at ${BASELINE_PATH}. Pass --force to replace it.`,
    )
    process.exit(1)
  }

  const capturedArticles = []
  const migratedArticleIds = []

  for (const { file } of ARTICLE_MODULE_IMPORTS) {
    const filePath = path.join(HELP_CONTENT_DIR, file)
    const sourceFile = parseSourceFile(filePath)
    const articles = collectArticlesFromSourceFile(sourceFile)

    for (const article of articles) {
      const { id, category, title, summary } = article.metadata
      if (!id) {
        throw new Error(`Article missing id in ${file}`)
      }
      if (!VALID_CATEGORIES.has(category)) {
        throw new Error(`Invalid category "${category}" for ${id}`)
      }

      if (article.contentSource === 'raw_md_import') {
        migratedArticleIds.push(id)
      }

      const normalizedContent = materializeArticleContent(
        sourceFile,
        article,
        allowMigratedSources,
      )

      if (normalizedContent == null) {
        continue
      }

      capturedArticles.push({
        id,
        metadata: {
          id,
          title,
          category,
          summary,
          keywords: article.metadata.keywords ?? [],
          relatedIds: article.metadata.relatedIds ?? [],
          contextKeys: article.metadata.contextKeys ?? [],
        },
        normalizedContent,
        contentSource: article.contentSource,
      })
    }
  }

  if (migratedArticleIds.length > 0 && !allowMigratedSources) {
    console.error(
      'Refusing baseline capture: the following articles already use raw .md imports:',
    )
    for (const id of migratedArticleIds) {
      console.error(`  - ${id}`)
    }
    console.error(
      'Capture a baseline from unmigrated TS template literals before migration. To override intentionally, pass --allow-migrated-sources.',
    )
    process.exit(1)
  }

  const contentSourceCounts = capturedArticles.reduce((counts, article) => {
    counts[article.contentSource] = (counts[article.contentSource] ?? 0) + 1
    return counts
  }, {})

  const output = {
    provenance: {
      generatedAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      helpContentSourceRoot: HELP_CONTENT_DIR,
      gitSha: getGitSha(),
      capturePolicy: allowMigratedSources
        ? CAPTURE_POLICY_MIGRATED
        : CAPTURE_POLICY_UNMIGRATED,
      contentSourceCounts,
      migratedArticleIds: allowMigratedSources ? migratedArticleIds : [],
    },
    articles: capturedArticles,
  }

  const outDir = path.dirname(BASELINE_PATH)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`)
  console.log(
    `Wrote baseline (${output.articles.length} articles, capturePolicy=${output.provenance.capturePolicy}) to ${BASELINE_PATH}`,
  )
}

main()
