import type { Readable, Writable } from 'node:stream'

export type Platform = 'darwin' | 'linux' | 'win32'

export interface WindowsBinaryModeSeam {
  setBinaryMode(fileDescriptor: 0 | 1): void
}

/**
 * Node/libuv pipe streams are binary by default. This seam makes the Windows
 * `_setmode` integration explicit for a future signed launcher without adding
 * a native dependency to the spike.
 */
export function configureBinaryStdio(
  platform: Platform,
  input: Readable,
  output: Writable,
  windowsSeam?: WindowsBinaryModeSeam,
): void {
  if (input.readableEncoding !== null) throw new Error('stdin must not have a text encoding')
  if (platform !== 'win32' || windowsSeam === undefined) return
  windowsSeam.setBinaryMode(0)
  windowsSeam.setBinaryMode(1)
  if (!output.writable) throw new Error('stdout must be writable')
}

export function assertSupportedPlatform(platform: NodeJS.Platform): asserts platform is Platform {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`unsupported native messaging platform: ${platform}`)
  }
}
