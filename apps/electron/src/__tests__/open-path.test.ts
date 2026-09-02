import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateAbsoluteLocalFilePath } from '../open-path.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempFile(name = 'spec.pdf'): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forge-open-path-'))
  tempRoots.push(root)
  const filePath = path.join(root, name)
  writeFileSync(filePath, '%PDF-1.4\n')
  return filePath
}

describe('validateAbsoluteLocalFilePath', () => {
  it('accepts an existing absolute path and rejects relative or missing paths', () => {
    const filePath = tempFile()
    expect(validateAbsoluteLocalFilePath(filePath)).toEqual({ ok: true, path: path.normalize(filePath) })
    expect(validateAbsoluteLocalFilePath('relative/spec.pdf')).toEqual({ ok: false, error: 'Path must be absolute' })
    expect(validateAbsoluteLocalFilePath('')).toEqual({ ok: false, error: 'Invalid file path' })
    expect(validateAbsoluteLocalFilePath(path.join(path.dirname(filePath), 'missing.pdf'))).toEqual({
      ok: false,
      error: 'File not found',
    })
  })
})
