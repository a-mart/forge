import { PassThrough } from 'node:stream'
import {
  EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES,
  EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES,
} from '@forge/protocol'
import { describe, expect, it } from 'vitest'
import {
  HOST_EXTENSION_ORIGIN,
  HOST_MAX_DESKTOP_UNAVAILABLE_BYTES,
  HOST_MAX_NATIVE_INBOUND_BYTES,
  HOST_MAX_NATIVE_OUTBOUND_BYTES,
  HOST_MAX_NEGOTIATED_MESSAGE_BYTES,
} from '../src/constants.js'
import { NativeMessageDecoder } from '../src/framing.js'
import { runNativeHost } from '../src/host.js'
import { validateChromeLaunchArguments } from '../src/launch.js'
import { DesktopUnavailableError, validateRendezvous, type RendezvousDocument } from '../src/transport.js'

function capture(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { stream, chunks }
}

const VALID_RENDEZVOUS: RendezvousDocument = {
  schemaVersion: 1,
  endpoint: '/tmp/forge.sock',
  epoch: 'epoch_1234567890abcdef',
  expiresAt: '2030-01-01T00:00:00.000Z',
  keyId: 'test-key',
  userScope: 'user-a',
  desktopInstanceId: 'desktop_1234567890abcdef',
  protocolMin: 1,
  protocolMax: 1,
}

describe('native host trust and process boundaries', () => {
  it('pins the exact extension origin and platform launch shape', () => {
    expect(() => validateChromeLaunchArguments([HOST_EXTENSION_ORIGIN], HOST_EXTENSION_ORIGIN, 'darwin')).not.toThrow()
    expect(() => validateChromeLaunchArguments(['chrome-extension://wrong/'], HOST_EXTENSION_ORIGIN, 'darwin')).toThrow(/pinned/u)
    expect(() => validateChromeLaunchArguments([HOST_EXTENSION_ORIGIN, '--extra'], HOST_EXTENSION_ORIGIN, 'linux')).toThrow(/unexpected/u)
    expect(() => validateChromeLaunchArguments(
      [HOST_EXTENSION_ORIGIN, '--parent-window=42'],
      HOST_EXTENSION_ORIGIN,
      'win32',
    )).not.toThrow()
    expect(() => validateChromeLaunchArguments(
      [HOST_EXTENSION_ORIGIN, '--parent-window=abc'],
      HOST_EXTENSION_ORIGIN,
      'win32',
    )).toThrow(/parent-window/u)
  })

  it('uses strict Forge bounds below Chrome native messaging limits', () => {
    expect(HOST_MAX_NATIVE_INBOUND_BYTES).toBeLessThan(EXTERNAL_CHROME_MAX_NATIVE_INBOUND_FRAME_BYTES)
    expect(HOST_MAX_NATIVE_OUTBOUND_BYTES).toBeLessThan(EXTERNAL_CHROME_MAX_NATIVE_OUTBOUND_FRAME_BYTES)
    expect(HOST_MAX_NEGOTIATED_MESSAGE_BYTES).toBeLessThan(HOST_MAX_NATIVE_OUTBOUND_BYTES)
  })

  it('rejects stale, cross-user, and network rendezvous documents', () => {
    const now = Date.parse('2029-01-01T00:00:00.000Z')
    expect(() => validateRendezvous(VALID_RENDEZVOUS, 'user-b', 'darwin', now)).toThrow(/another user/u)
    expect(() => validateRendezvous({
      ...VALID_RENDEZVOUS,
      expiresAt: '2028-01-01T00:00:00.000Z',
    }, 'user-a', 'darwin', now)).toThrow(/stale/u)
    expect(() => validateRendezvous({
      ...VALID_RENDEZVOUS,
      endpoint: 'tcp://127.0.0.1:1234',
    }, 'user-a', 'darwin', now)).toThrow(/Unix-domain/u)
    expect(() => validateRendezvous({
      ...VALID_RENDEZVOUS,
      endpoint: '\\\\.\\pipe\\forge-user-a',
    }, 'user-a', 'win32', now)).not.toThrow()
  })

  it('keeps diagnostics on stderr and emits one bounded desktop-unavailable frame on stdout', async () => {
    const input = new PassThrough()
    const stdout = capture()
    const stderr = capture()
    const exitCode = await runNativeHost({
      input,
      output: stdout.stream,
      diagnostic: stderr.stream,
      platform: 'darwin',
      launchArguments: [HOST_EXTENSION_ORIGIN],
      connectRelay: async () => {
        throw new DesktopUnavailableError('expected private diagnostic')
      },
    })
    expect(exitCode).toBe(1)
    const stdoutBytes = Buffer.concat(stdout.chunks)
    expect(stdoutBytes.byteLength).toBeLessThan(HOST_MAX_DESKTOP_UNAVAILABLE_BYTES)
    expect(new NativeMessageDecoder(HOST_MAX_DESKTOP_UNAVAILABLE_BYTES).push(stdoutBytes)).toEqual([{
      type: 'desktop-unavailable',
      code: 'desktop-unavailable',
      retryable: true,
    }])
    expect(stdoutBytes.toString('utf8')).not.toContain('private diagnostic')
    expect(Buffer.concat(stderr.chunks).toString('utf8')).toContain('private diagnostic')
  })

  it('writes no protocol bytes for a wrong origin', async () => {
    const stdout = capture()
    const stderr = capture()
    const exitCode = await runNativeHost({
      input: new PassThrough(),
      output: stdout.stream,
      diagnostic: stderr.stream,
      platform: 'darwin',
      launchArguments: ['chrome-extension://wrong/'],
      connectRelay: async () => {
        throw new Error('must not connect')
      },
    })
    expect(exitCode).toBe(2)
    expect(Buffer.concat(stdout.chunks)).toHaveLength(0)
    expect(Buffer.concat(stderr.chunks).toString('utf8')).toContain('pinned extension')
  })
})
