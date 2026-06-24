import { describe, expect, it } from 'vitest'
import { doesDeleteAffectOpenFile, isPdfFile } from './file-browser-utils'

describe('isPdfFile', () => {
  it('detects pdf extensions case-insensitively', () => {
    expect(isPdfFile('docs/spec.pdf')).toBe(true)
    expect(isPdfFile('docs/spec.PDF')).toBe(true)
    expect(isPdfFile('readme.md')).toBe(false)
    expect(isPdfFile('archive.pdfx')).toBe(false)
  })
})

describe('doesDeleteAffectOpenFile', () => {
  it('matches exact files and ancestor folders', () => {
    expect(doesDeleteAffectOpenFile('src/App.tsx', 'file', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectOpenFile('src', 'directory', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectOpenFile('src/components', 'directory', 'src/App.tsx')).toBe(false)
    expect(doesDeleteAffectOpenFile('other.ts', 'file', 'src/App.tsx')).toBe(false)
    expect(doesDeleteAffectOpenFile('src/App.tsx', 'file', null)).toBe(false)
  })
})
