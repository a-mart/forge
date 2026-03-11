import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { isPidAlive, resolveProdDaemonIpcPaths } from '../prod-daemon-ipc.mjs'

describe('prod-daemon-ipc', () => {
  it('derives stable pid and restart file paths from the repo root', () => {
    const repoRoot = '/repo/root'
    const paths = resolveProdDaemonIpcPaths(repoRoot)

    expect(paths.prefix).toMatch(new RegExp(`^${escapeRegExp(path.join(os.tmpdir(), 'swarm-prod-daemon-'))}[a-f0-9]{10}$`))
    expect(paths.pidFile).toBe(`${paths.prefix}.pid`)
    expect(paths.restartFile).toBe(`${paths.prefix}.restart`)
  })

  it('treats EPERM as alive and ESRCH as dead', () => {
    const killSpy = vi.spyOn(process, 'kill')

    killSpy.mockImplementationOnce(() => true)
    expect(isPidAlive(123)).toBe(true)

    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    expect(isPidAlive(456)).toBe(true)

    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    })
    expect(isPidAlive(789)).toBe(false)

    killSpy.mockRestore()
  })
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
