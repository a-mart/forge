import { endianness } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { TextDecoder } from 'node:util'

export type JsonObject = Record<string, unknown>

export class NativeMessageError extends Error {
  constructor(
    readonly code: 'malformed-frame' | 'message-too-large' | 'truncated-frame',
    message: string,
  ) {
    super(message)
    this.name = 'NativeMessageError'
  }
}

function readLength(buffer: Buffer): number {
  return endianness() === 'LE' ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0)
}

function writeLength(buffer: Buffer, length: number): void {
  if (endianness() === 'LE') buffer.writeUInt32LE(length, 0)
  else buffer.writeUInt32BE(length, 0)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class NativeMessageDecoder {
  private buffered = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Uint8Array): JsonObject[] {
    if (chunk.byteLength === 0) return []
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)])
    const messages: JsonObject[] = []

    while (this.buffered.byteLength >= 4) {
      const length = readLength(this.buffered)
      if (length === 0) throw new NativeMessageError('malformed-frame', 'native message payload must not be empty')
      if (length > this.maxFrameBytes) {
        throw new NativeMessageError('message-too-large', `native message length ${length} exceeds ${this.maxFrameBytes}`)
      }
      if (this.buffered.byteLength < length + 4) break

      const payload = this.buffered.subarray(4, length + 4)
      this.buffered = this.buffered.subarray(length + 4)
      let parsed: unknown
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
      } catch {
        throw new NativeMessageError('malformed-frame', 'native message payload is not valid UTF-8 JSON')
      }
      if (!isJsonObject(parsed)) {
        throw new NativeMessageError('malformed-frame', 'native message payload must be a JSON object')
      }
      messages.push(parsed)
    }

    return messages
  }

  end(): void {
    if (this.buffered.byteLength !== 0) {
      throw new NativeMessageError('truncated-frame', `native message ended with ${this.buffered.byteLength} buffered bytes`)
    }
  }
}

export function encodeNativeMessage(message: JsonObject, maxFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.byteLength === 0 || payload.byteLength > maxFrameBytes) {
    throw new NativeMessageError('message-too-large', `native message length ${payload.byteLength} exceeds ${maxFrameBytes}`)
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4)
  writeLength(frame, payload.byteLength)
  payload.copy(frame, 4)
  return frame
}

export async function* readNativeMessages(input: Readable, maxFrameBytes: number): AsyncGenerator<JsonObject> {
  const decoder = new NativeMessageDecoder(maxFrameBytes)
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) {
      throw new NativeMessageError('malformed-frame', 'native messaging input must remain in binary mode')
    }
    for (const message of decoder.push(chunk)) yield message
  }
  decoder.end()
}

export async function writeNativeMessage(output: Writable, message: JsonObject, maxFrameBytes: number): Promise<void> {
  const frame = encodeNativeMessage(message, maxFrameBytes)
  await new Promise<void>((resolve, reject) => {
    output.write(frame, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
