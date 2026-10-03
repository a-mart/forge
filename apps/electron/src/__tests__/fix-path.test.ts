import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

let mockedExec: ReturnType<typeof vi.fn>

describe('fix-path', () => {
  let originalPath: string | undefined
  let originalShell: string | undefined

  beforeEach(async () => {
    vi.resetModules()
    mockedExec = vi.mocked((await import('node:child_process')).execFileSync)
    mockedExec.mockReset()
    originalPath = process.env.PATH
    originalShell = process.env.SHELL
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
  })

  it('is a no-op on Windows without invoking a shell', async () => {
    if (process.platform !== 'win32') return
    process.env.PATH = '/inherited'
    const { fixPath } = await import('../fix-path.js')
    fixPath()
    expect(process.env.PATH).toBe('/inherited')
    expect(mockedExec).not.toHaveBeenCalled()
  })

  it('extracts an ANSI-wrapped PATH and merges shell precedence without duplicates', async () => {
    if (process.platform === 'win32') return
    process.env.SHELL = '/bin/zsh'
    process.env.PATH = '/gui/bin:/shared:/gui/bin'
    mockedExec.mockReturnValue('notice\n\x1b[32mPATH=/shell/bin:/shared:/shell/bin\x1b[0m\n' as never)
    const { fixPath } = await import('../fix-path.js')

    fixPath()
    expect(process.env.PATH).toBe('/shell/bin:/shared:/gui/bin')
    expect(mockedExec).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'echo PATH="$PATH"'], expect.objectContaining({ timeout: 5000 }))
  })

  it('uses fish login syntax and leaves PATH unchanged when extraction fails', async () => {
    if (process.platform === 'win32') return
    process.env.SHELL = '/usr/bin/fish'
    process.env.PATH = '/inherited'
    mockedExec.mockReturnValue('fish startup output\n' as never)
    const { fixPath } = await import('../fix-path.js')

    fixPath()
    expect(process.env.PATH).toBe('/inherited')
    expect(mockedExec).toHaveBeenCalledWith('/usr/bin/fish', ['-l', '-c', 'echo PATH="$PATH"'], expect.anything())
  })

  it('fails closed for missing shell and shell execution errors', async () => {
    if (process.platform === 'win32') return
    delete process.env.SHELL
    process.env.PATH = '/inherited'
    const { fixPath } = await import('../fix-path.js')
    fixPath()
    expect(process.env.PATH).toBe('/inherited')
    process.env.SHELL = '/invalid/shell'
    mockedExec.mockImplementation(() => { throw new Error('timeout') })
    fixPath()
    expect(process.env.PATH).toBe('/inherited')
  })
})
