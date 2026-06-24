import { parseArtifactReference, toSwarmFileHref, type ArtifactReference } from './artifacts'
import type { ConversationEntry } from '@forge/protocol'

const ARTIFACT_SHORTCODE_PATTERN = /\[artifact:([^\]\n]+)\]/gi
const SWARM_FILE_PATTERN = /swarm-file:\/\/[^\s)>\]"']+/gi
const VSCODE_FILE_PATTERN = /vscode(?:-insiders)?:\/\/file\/[^\s)>\]"']+/gi
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)]+)\)/g
const CODEX_PLUGIN_EXPORT_TOOL_NAME = 'export_scoped_codex_plugin_result'
const EXPLICIT_EXPORT_ARTIFACT_FIELDS = ['artifactMarkdown', 'manifestMarkdown'] as const
const EXPLICIT_EXPORT_ARTIFACT_ARRAY_FIELDS = ['artifactLinks'] as const
const EXPLICIT_EXPORT_ARTIFACT_LINK_FIELDS = ['artifactMarkdown', 'manifestMarkdown', 'markdown', 'href'] as const

/**
 * Collect all unique artifact references from a list of conversation entries.
 * Deduplicates by normalized file path and returns last-seen items first.
 */
export function collectArtifactsFromMessages(messages: ConversationEntry[]): ArtifactReference[] {
  const seen = new Map<string, ArtifactReference>()

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    const artifactTexts = getArtifactCandidateTexts(message)
    if (artifactTexts.length === 0) continue

    const sourceAgentId = getArtifactSourceAgentId(message)

    for (const artifactText of artifactTexts) {
      collectArtifactReferencesFromText(artifactText, sourceAgentId, seen)
    }
  }

  return Array.from(seen.values())
}

/** Categorize an artifact by its file extension. */
export type ArtifactCategory = 'document' | 'code' | 'image' | 'data' | 'other'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])
const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'pdf', 'doc', 'docx', 'rtf'])
const DATA_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'csv', 'xml', 'env'])
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'Dockerfile', 'Makefile',
])

export function categorizeArtifact(fileName: string): ArtifactCategory {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document'
  if (DATA_EXTENSIONS.has(ext)) return 'data'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  return 'other'
}

function collectArtifactReferencesFromText(
  artifactText: string,
  sourceAgentId: string | undefined,
  seen: Map<string, ArtifactReference>,
): void {
  const codeRanges = findMarkdownCodeRanges(artifactText)

  // Extract from [artifact:path] shortcodes
  for (const match of artifactText.matchAll(ARTIFACT_SHORTCODE_PATTERN)) {
    if (isMatchInCodeRange(match, codeRanges)) continue

    const rawPath = match[1]?.trim()
    if (!isValidArtifactCandidate(rawPath)) continue
    const ref = parseArtifactReference(toSwarmFileHref(rawPath), { sourceAgentId })
    addArtifactReference(ref, seen)
  }

  // Extract swarm-file:// links
  for (const match of artifactText.matchAll(SWARM_FILE_PATTERN)) {
    if (isMatchInCodeRange(match, codeRanges)) continue

    const ref = parseArtifactReference(match[0], { sourceAgentId })
    addArtifactReference(ref, seen)
  }

  // Extract vscode:// / vscode-insiders:// links
  for (const match of artifactText.matchAll(VSCODE_FILE_PATTERN)) {
    if (isMatchInCodeRange(match, codeRanges)) continue

    const ref = parseArtifactReference(match[0], { sourceAgentId })
    addArtifactReference(ref, seen)
  }

  // Extract from markdown links [text](href)
  for (const match of artifactText.matchAll(MARKDOWN_LINK_PATTERN)) {
    if (isMatchInCodeRange(match, codeRanges)) continue

    const matchIndex = match.index ?? 0
    if (matchIndex > 0 && artifactText[matchIndex - 1] === '!') {
      continue
    }

    const linkText = match[1]?.trim()
    const href = parseMarkdownLinkHref(match[2] ?? '')
    if (!isValidArtifactCandidate(href)) continue
    const ref = parseArtifactReference(href, { title: linkText, sourceAgentId })
    addArtifactReference(ref, seen)
  }
}

function addArtifactReference(
  ref: ArtifactReference | null,
  seen: Map<string, ArtifactReference>,
): void {
  if (!ref || !isValidArtifactCandidate(ref.path) || seen.has(ref.path)) {
    return
  }

  seen.set(ref.path, ref)
}

function isValidArtifactCandidate(value: string | undefined): value is string {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  if (/[`<>]/.test(trimmed)) {
    return false
  }

  if (trimmed.includes('…') || trimmed.includes('...')) {
    return false
  }

  if (/\{\{[^}]+\}\}|\$\{[^}]+\}/.test(trimmed)) {
    return false
  }

  const withoutQuery = trimmed.split(/[?#]/, 1)[0]?.trim() ?? ''
  const fileName = withoutQuery.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.trim() ?? ''
  if (!fileName || fileName === '.' || fileName === '..') {
    return false
  }

  return true
}

interface TextRange {
  start: number
  end: number
}

function findMarkdownCodeRanges(text: string): TextRange[] {
  const ranges = findFencedCodeRanges(text)

  const inlineCodePattern = /`[^`\n]+`/g
  for (const match of text.matchAll(inlineCodePattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (!ranges.some((range) => start >= range.start && end <= range.end)) {
      ranges.push({ start, end })
    }
  }

  return ranges
}

interface OpenFence {
  char: '`' | '~'
  length: number
  start: number
}

function findFencedCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  let openFence: OpenFence | undefined
  let lineStart = 0

  while (lineStart < text.length) {
    const newlineIndex = text.indexOf('\n', lineStart)
    const lineEnd = newlineIndex >= 0 ? newlineIndex + 1 : text.length
    const line = text.slice(lineStart, newlineIndex >= 0 ? newlineIndex : lineEnd)

    if (openFence) {
      if (isClosingFenceLine(line, openFence)) {
        ranges.push({ start: openFence.start, end: lineEnd })
        openFence = undefined
      }
    } else {
      const openingFence = getOpeningFence(line)
      if (openingFence) {
        openFence = { ...openingFence, start: lineStart }
      }
    }

    lineStart = lineEnd
  }

  if (openFence) {
    ranges.push({ start: openFence.start, end: text.length })
  }

  return ranges
}

function getOpeningFence(line: string): Pick<OpenFence, 'char' | 'length'> | undefined {
  const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
  if (!match) {
    return undefined
  }

  const fence = match[1]
  return { char: fence[0] as '`' | '~', length: fence.length }
}

function isClosingFenceLine(line: string, openFence: OpenFence): boolean {
  const escapedChar = openFence.char === '`' ? '`' : '~'
  const pattern = new RegExp(`^[ \\t]{0,3}${escapedChar}{${openFence.length},}[ \\t]*$`)
  return pattern.test(line)
}

function isMatchInCodeRange(match: RegExpMatchArray, ranges: TextRange[]): boolean {
  const start = match.index ?? 0
  return ranges.some((range) => start >= range.start && start < range.end)
}

function getArtifactCandidateTexts(message: ConversationEntry): string[] {
  switch (message.type) {
    case 'conversation_message':
      return message.role === 'user' || !message.text ? [] : [message.text]
    case 'agent_message':
      return message.text ? [message.text] : []
    case 'agent_tool_call':
      return getArtifactCandidateTextsFromToolCall(message)
    default:
      return []
  }
}

function getArtifactCandidateTextsFromToolCall(
  message: Extract<ConversationEntry, { type: 'agent_tool_call' }>,
): string[] {
  if (message.kind !== 'tool_execution_end' || message.toolName !== CODEX_PLUGIN_EXPORT_TOOL_NAME) {
    return []
  }

  return extractExplicitArtifactTextsFromExportResult(message.text)
}

function extractExplicitArtifactTextsFromExportResult(text: string): string[] {
  const parsed = parseJsonObject(text)
  if (!parsed) {
    return []
  }

  const artifactTexts: string[] = []
  for (const field of EXPLICIT_EXPORT_ARTIFACT_FIELDS) {
    const value = parsed[field]
    if (typeof value === 'string' && value.trim()) {
      artifactTexts.push(value)
    }
  }

  for (const field of EXPLICIT_EXPORT_ARTIFACT_ARRAY_FIELDS) {
    const value = parsed[field]
    if (!Array.isArray(value)) {
      continue
    }

    artifactTexts.push(...extractExplicitArtifactTextsFromArray(value))
  }

  return artifactTexts
}

function extractExplicitArtifactTextsFromArray(values: unknown[]): string[] {
  const artifactTexts: string[] = []
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      artifactTexts.push(value)
      continue
    }

    if (!isRecord(value)) {
      continue
    }

    for (const field of EXPLICIT_EXPORT_ARTIFACT_LINK_FIELDS) {
      const linkValue = value[field]
      if (typeof linkValue === 'string' && linkValue.trim()) {
        artifactTexts.push(linkValue)
      }
    }
  }

  return artifactTexts
}

function getArtifactSourceAgentId(message: ConversationEntry): string | undefined {
  switch (message.type) {
    case 'conversation_message':
      return message.agentId
    case 'agent_message':
      return message.fromAgentId ?? message.agentId
    case 'agent_tool_call':
      return message.actorAgentId
    default:
      return undefined
  }
}

function parseMarkdownLinkHref(rawHref: string): string {
  const trimmedHref = rawHref.trim()
  if (!trimmedHref) {
    return ''
  }

  if (trimmedHref.startsWith('<') && trimmedHref.endsWith('>')) {
    return trimmedHref.slice(1, -1).trim()
  }

  const titleSeparatorIndex = trimmedHref.search(/\s+(?:"|')/)
  if (titleSeparatorIndex > 0) {
    return trimmedHref.slice(0, titleSeparatorIndex).trim()
  }

  return trimmedHref
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
