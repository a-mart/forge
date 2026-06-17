import { describe, expect, it } from 'vitest'
import { doesDeleteAffectOpenFile } from './file-browser-utils'

describe('doesDeleteAffectOpenFile', () => {
  it('matches exact files and ancestor folders', () => {
    expect(doesDeleteAffectOpenFile('src/App.tsx', 'file', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectOpenFile('src', 'directory', 'src/App.tsx')).toBe(true)
    expect(doesDeleteAffectOpenFile('src/components', 'directory', 'src/App.tsx')).toBe(false)
    expect(doesDeleteAffectOpenFile('other.ts', 'file', 'src/App.tsx')).toBe(false)
    expect(doesDeleteAffectOpenFile('src/App.tsx', 'file', null)).toBe(false)
  })
})
