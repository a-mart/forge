import { describe, expect, it } from 'vitest'
import { doesDeleteAffectFile, isPdfFile } from './file-browser-utils'

describe('isPdfFile', () => {
  it('detects pdf extensions case-insensitively', () => {
    expect(isPdfFile('docs/spec.pdf')).toBe(true)
    expect(isPdfFile('docs/spec.PDF')).toBe(true)
    expect(isPdfFile('readme.md')).toBe(false)
    expect(isPdfFile('archive.pdfx')).toBe(false)
  })
})

describe('doesDeleteAffectFile', () => {
  it('matches exact files and ancestor folders', () => {
    expect(doesDeleteAffectFile('src/App.tsx', 'file', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectFile('src', 'directory', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectFile('src/components', 'directory', 'src/App.tsx')).toBe(false)
    expect(doesDeleteAffectFile('other.ts', 'file', 'src/App.tsx')).toBe(false)
    expect(doesDeleteAffectFile('/src/', 'directory', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectFile('/', 'directory', 'src/App.tsx')).toBe(false)
  })
})
