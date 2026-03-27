import { describe, expect, it } from 'vitest'
import { buildMarkdownDiffSections, parseMarkdownSections } from './markdown-diff-sections'

describe('parseMarkdownSections', () => {
  it('detects headings across multiple levels and assigns stable line ranges', () => {
    const sections = parseMarkdownSections([
      '# Title',
      'Intro text',
      '## Details',
      'Detail line',
      '### Deep dive',
      'Deep content',
      '## Wrap up',
      'Final note',
    ].join('\n'))

    expect(sections.map((section) => ({
      title: section.title,
      level: section.level,
      startLine: section.startLine,
      endLine: section.endLine,
    }))).toEqual([
      { title: 'Title', level: 1, startLine: 1, endLine: 2 },
      { title: 'Details', level: 2, startLine: 3, endLine: 4 },
      { title: 'Deep dive', level: 3, startLine: 5, endLine: 6 },
      { title: 'Wrap up', level: 2, startLine: 7, endLine: 8 },
    ])
  })

  it('returns a stable fallback outline when content has no headings', () => {
    const sections = parseMarkdownSections('Paragraph one\n\nParagraph two')

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({
      title: 'Document',
      level: 1,
      startLine: 1,
      endLine: 3,
      synthetic: true,
    })
  })

  it('handles empty content with a single fallback section', () => {
    const sections = parseMarkdownSections('')

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({
      title: 'Document',
      level: 1,
      startLine: 1,
      endLine: 1,
      synthetic: true,
    })
  })

  it('ignores headings inside fenced code blocks and html comments', () => {
    const sections = parseMarkdownSections([
      '# Visible',
      '```md',
      '## Hidden code heading',
      '```',
      '<!--',
      '## Hidden comment heading',
      '-->',
      '## Visible child',
      'Body',
    ].join('\n'))

    expect(sections.map((section) => section.title)).toEqual(['Visible', 'Visible child'])
  })
})

describe('buildMarkdownDiffSections', () => {
  it('marks unchanged sections without dropping them from the outline', () => {
    const oldContent = ['# Intro', 'Same', '## Stable', 'Nothing changed'].join('\n')
    const newContent = ['# Intro', 'Updated', '## Stable', 'Nothing changed'].join('\n')

    const result = buildMarkdownDiffSections(oldContent, newContent)

    expect(result.outlineSections.map((section) => section.title)).toEqual(['Intro', 'Stable'])
    expect(result.diffSections.map((section) => ({ title: section.title, hasChanges: section.hasChanges }))).toEqual([
      { title: 'Intro', hasChanges: true },
      { title: 'Stable', hasChanges: false },
    ])
  })
})
