import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rotateLogFileIfLarge } from '../log-rotation'

describe('rotateLogFileIfLarge', () => {
  const dirs: string[] = []
  const makeDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'forge-log-rotation-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing when the log does not exist', () => {
    const logPath = path.join(makeDir(), 'backend.log')
    expect(rotateLogFileIfLarge(logPath, 10)).toBe(false)
    expect(existsSync(logPath)).toBe(false)
  })

  it('keeps a log at or below the threshold in place', () => {
    const logPath = path.join(makeDir(), 'backend.log')
    writeFileSync(logPath, '0123456789')
    expect(rotateLogFileIfLarge(logPath, 10)).toBe(false)
    expect(readFileSync(logPath, 'utf8')).toBe('0123456789')
  })

  it('moves an oversized log to one previous generation, replacing the older one', () => {
    const logPath = path.join(makeDir(), 'backend.log')
    writeFileSync(`${logPath}.1`, 'older')
    writeFileSync(logPath, 'current-and-large')
    expect(rotateLogFileIfLarge(logPath, 10)).toBe(true)
    expect(existsSync(logPath)).toBe(false)
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('current-and-large')
  })

  it('reports rotation failures without throwing', () => {
    const onError = vi.fn()
    const logPath = path.join(makeDir(), 'backend.log')
    writeFileSync(logPath, 'current-and-large')
    expect(rotateLogFileIfLarge(logPath, 10, {
      rename: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
      onError,
    })).toBe(false)
    expect(onError).toHaveBeenCalledOnce()
    expect(readFileSync(logPath, 'utf8')).toBe('current-and-large')
  })
})
