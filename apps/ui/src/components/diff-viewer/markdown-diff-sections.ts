export interface MarkdownSection {
  id: string
  title: string
  level: number
  headingLine: number
  startLine: number
  endLine: number
  path: string[]
  synthetic?: boolean
}

export interface MarkdownDiffSection extends MarkdownSection {
  oldContent: string
  newContent: string
  hasChanges: boolean
  changeKind: 'added' | 'modified' | 'removed' | 'unchanged'
  removed?: boolean
}

const FALLBACK_SECTION_TITLE = 'Document'
const HEADING_PATTERN = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*$/u
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/u

interface ParsedHeading {
  level: number
  title: string
  lineNumber: number
}

export function parseMarkdownSections(content: string): MarkdownSection[] {
  const lines = splitMarkdownLines(content)
  const headings: ParsedHeading[] = []

  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  let inHtmlComment = false

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1
    const line = rawLine ?? ''

    if (inFence) {
      if (isFenceClose(line, fenceChar, fenceLength)) {
        inFence = false
        fenceChar = ''
        fenceLength = 0
      }
      continue
    }

    const fenceMatch = line.match(FENCE_PATTERN)
    if (fenceMatch) {
      inFence = true
      fenceChar = fenceMatch[1][0]
      fenceLength = fenceMatch[1].length
      continue
    }

    if (inHtmlComment) {
      if (line.includes('-->')) {
        inHtmlComment = false
      }
      continue
    }

    const trimmedStart = line.trimStart()
    if (trimmedStart.startsWith('<!--')) {
      if (!trimmedStart.includes('-->')) {
        inHtmlComment = true
      }
      continue
    }

    const match = line.match(HEADING_PATTERN)
    if (!match) {
      continue
    }

    const title = normalizeHeadingText(match[2])
    if (!title) {
      continue
    }

    headings.push({
      level: match[1].length,
      title,
      lineNumber,
    })
  }

  if (headings.length === 0) {
    return [
      {
        id: 'document:1',
        title: FALLBACK_SECTION_TITLE,
        level: 1,
        headingLine: 1,
        startLine: 1,
        endLine: lines.length,
        path: [FALLBACK_SECTION_TITLE],
        synthetic: true,
      },
    ]
  }

  const sections: MarkdownSection[] = []
  const pathStack: string[] = []
  const occurrenceCounts = new Map<string, number>()

  for (const [index, heading] of headings.entries()) {
    pathStack[heading.level - 1] = heading.title
    pathStack.length = heading.level

    const path = pathStack.slice()
    const rawPath = path.join(' > ')
    const occurrence = (occurrenceCounts.get(rawPath) ?? 0) + 1
    occurrenceCounts.set(rawPath, occurrence)

    sections.push({
      id: `${slugify(rawPath)}:${occurrence}`,
      title: heading.title,
      level: heading.level,
      headingLine: heading.lineNumber,
      startLine: heading.lineNumber,
      endLine: (headings[index + 1]?.lineNumber ?? lines.length + 1) - 1,
      path,
    })
  }

  return sections
}

export function buildMarkdownDiffSections(
  oldContent: string,
  newContent: string,
): { outlineSections: MarkdownSection[]; diffSections: MarkdownDiffSection[] } {
  const oldSections = parseMarkdownSections(oldContent)
  const outlineSections = parseMarkdownSections(newContent)
  const oldSectionsById = new Map(oldSections.map((section) => [section.id, section]))
  const outlineSectionIds = new Set(outlineSections.map((section) => section.id))

  const diffSections = outlineSections.map((section) => {
    const matchingOldSection = oldSectionsById.get(section.id)
    const nextOldContent = matchingOldSection
      ? getMarkdownSectionContent(oldContent, matchingOldSection)
      : ''
    const nextNewContent = getMarkdownSectionContent(newContent, section)
    const hasChanges = nextOldContent !== nextNewContent

    return {
      ...section,
      oldContent: nextOldContent,
      newContent: nextNewContent,
      hasChanges,
      changeKind: matchingOldSection == null ? 'added' : hasChanges ? 'modified' : 'unchanged',
    } satisfies MarkdownDiffSection
  })

  if (outlineSections.length === 1 && outlineSections[0].synthetic) {
    const syntheticSection = diffSections[0]
    if (syntheticSection) {
      syntheticSection.oldContent = oldContent
      syntheticSection.newContent = newContent
      syntheticSection.hasChanges = oldContent !== newContent
      syntheticSection.changeKind = syntheticSection.hasChanges ? 'modified' : 'unchanged'
    }
    return { outlineSections, diffSections }
  }

  const removedSections = oldSections
    .filter((section) => !outlineSectionIds.has(section.id))
    .map((section) => ({
      ...section,
      oldContent: getMarkdownSectionContent(oldContent, section),
      newContent: '',
      hasChanges: true,
      changeKind: 'removed' as const,
      removed: true,
    }))

  return {
    outlineSections,
    diffSections: [...diffSections, ...removedSections],
  }
}

export function getMarkdownSectionContent(content: string, section: Pick<MarkdownSection, 'startLine' | 'endLine'>): string {
  const lines = splitMarkdownLines(content)
  if (lines.length === 0) {
    return ''
  }

  const startIndex = Math.max(section.startLine - 1, 0)
  const endIndex = Math.max(section.endLine, section.startLine - 1)
  return lines.slice(startIndex, endIndex).join('\n')
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/\s+#+\s*$/u, '')
    .replace(/<!--.*?-->/gu, '')
    .trim()
}

function splitMarkdownLines(content: string): string[] {
  return content.replace(/\r\n?/gu, '\n').split('\n')
}

function isFenceClose(line: string, fenceChar: string, fenceLength: number): boolean {
  if (!fenceChar || fenceLength === 0) {
    return false
  }

  const closePattern = new RegExp(`^\\s*${escapeRegExp(fenceChar)}{${fenceLength},}\\s*$`, 'u')
  return closePattern.test(line)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'section'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
