import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  encodeNativeMessage,
  NativeMessageDecoder,
  NativeMessageError,
  readNativeMessages,
  writeNativeMessage,
} from '../src/framing.js'
import { configureBinaryStdio } from '../src/platform.js'

const MAX = 1_024

describe('native messaging framing', () => {
  it('decodes fragmented frames', () => {
    const frame = encodeNativeMessage({ hello: 'world' }, MAX)
    const decoder = new NativeMessageDecoder(MAX)
    expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.push(frame.subarray(2, 7))).toEqual([])
    expect(decoder.push(frame.subarray(7))).toEqual([{ hello: 'world' }])
    decoder.end()
  })

  it('decodes multiple coalesced frames', () => {
    const decoder = new NativeMessageDecoder(MAX)
    const combined = Buffer.concat([
      encodeNativeMessage({ id: 1 }, MAX),
      encodeNativeMessage({ id: 2 }, MAX),
    ])
    expect(decoder.push(combined)).toEqual([{ id: 1 }, { id: 2 }])
  })

  it.each([
    Buffer.from([1, 0, 0, 0, 0xff]),
    Buffer.from([4, 0, 0, 0, 0x6e, 0x75, 0x6c, 0x6c]),
    Buffer.from([1, 0, 0, 0, 0x7b]),
  ])('rejects malformed JSON objects and invalid UTF-8', (frame) => {
    const decoder = new NativeMessageDecoder(MAX)
    expect(() => decoder.push(frame)).toThrow(NativeMessageError)
  })

  it('rejects an oversized length before buffering its body', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(MAX + 1)
    expect(() => new NativeMessageDecoder(MAX).push(header)).toThrowError(/exceeds/u)
  })

  it('rejects EOF in a partial header or body', () => {
    const headerOnly = new NativeMessageDecoder(MAX)
    headerOnly.push(Buffer.from([1, 0]))
    expect(() => headerOnly.end()).toThrowError(/buffered bytes/u)

    const partialBody = new NativeMessageDecoder(MAX)
    partialBody.push(encodeNativeMessage({ a: 1 }, MAX).subarray(0, 6))
    expect(() => partialBody.end()).toThrowError(/buffered bytes/u)
  })

  it('keeps stdin binary and exercises the Windows binary-mode seam', () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const descriptors: number[] = []
    configureBinaryStdio('win32', input, output, {
      setBinaryMode: (descriptor) => descriptors.push(descriptor),
    })
    expect(input.readableEncoding).toBeNull()
    expect(descriptors).toEqual([0, 1])
  })

  it('awaits writable completion for backpressure', async () => {
    let release: (() => void) | undefined
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        release = callback
      },
    })
    let settled = false
    const pending = writeNativeMessage(output, { bounded: true }, MAX).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await pending
    expect(settled).toBe(true)
  })

  it('reads binary stream fragments without changing mode', async () => {
    const input = new PassThrough()
    const frame = encodeNativeMessage({ ok: true }, MAX)
    input.end(frame)
    const messages = []
    for await (const message of readNativeMessages(input, MAX)) messages.push(message)
    expect(messages).toEqual([{ ok: true }])
  })
})
