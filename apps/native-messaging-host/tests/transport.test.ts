import { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { authenticateRecord } from '../src/auth.js'
import { encodeNativeMessage } from '../src/framing.js'
import {
  FramedSocketTransport,
  RelayBackpressureError,
} from '../src/transport.js'

const MAX_RECORD_BYTES = 1_024

class ControlledDuplex extends Duplex {
  stallWrites = false

  override _read(): void {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.stallWrites) callback()
  }
}

function produce(socket: ControlledDuplex, records: Array<Record<string, unknown>>): void {
  socket.push(Buffer.concat(records.map((record) => encodeNativeMessage(record, MAX_RECORD_BYTES))))
}

async function flushStreamEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('framed relay socket backpressure', () => {
  it('accepts the exact message threshold then closes deterministically on overflow', async () => {
    const socket = new ControlledDuplex()
    const transport = new FramedSocketTransport(socket, MAX_RECORD_BYTES, {
      maxRecords: 2,
      maxDecodedBytes: 1_024,
    })

    produce(socket, [{ id: 1 }, { id: 2 }])
    await flushStreamEvents()
    expect(transport.queuedRecordCount).toBe(2)
    expect(transport.queuedDecodedBytes).toBe(Buffer.byteLength('{"id":1}{"id":2}', 'utf8'))
    expect(socket.destroyed).toBe(false)

    produce(socket, [{ id: 3 }])
    await flushStreamEvents()
    expect(socket.destroyed).toBe(true)
    expect(transport.queuedRecordCount).toBe(0)
    expect(transport.queuedDecodedBytes).toBe(0)
    await expect(transport.receive()).rejects.toBeInstanceOf(RelayBackpressureError)
  })

  it('accepts the exact decoded-byte threshold then closes on the next byte', async () => {
    const record = { payload: 'bounded' }
    const decodedBytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
    const socket = new ControlledDuplex()
    const transport = new FramedSocketTransport(socket, MAX_RECORD_BYTES, {
      maxRecords: 10,
      maxDecodedBytes: decodedBytes,
    })

    produce(socket, [record])
    await flushStreamEvents()
    expect(transport.queuedDecodedBytes).toBe(decodedBytes)
    expect(socket.destroyed).toBe(false)

    produce(socket, [{ x: 1 }])
    await flushStreamEvents()
    expect(socket.destroyed).toBe(true)
    expect(transport.queuedRecordCount).toBe(0)
    expect(transport.queuedDecodedBytes).toBe(0)
    await expect(transport.receive()).rejects.toBeInstanceOf(RelayBackpressureError)
  })

  it('bounds a fast producer while the authenticated consumer is stalled and releases all accounting on close', async () => {
    const socket = new ControlledDuplex()
    const transport = new FramedSocketTransport(socket, MAX_RECORD_BYTES, {
      maxRecords: 4,
      maxDecodedBytes: 1_024,
    })

    const key = Buffer.alloc(32, 0x4a)
    for (let sequence = 0; sequence < 100 && !socket.destroyed; sequence += 1) {
      produce(socket, [authenticateRecord({
        type: 'relay',
        epoch: 'epoch_1234567890abcdef',
        sequence,
        payload: { id: sequence },
      }, key)])
    }
    key.fill(0)
    await flushStreamEvents()

    expect(socket.destroyed).toBe(true)
    expect(transport.queuedRecordCount).toBe(0)
    expect(transport.queuedDecodedBytes).toBe(0)
    await expect(transport.receive()).rejects.toBeInstanceOf(RelayBackpressureError)
    transport.close()
    expect(transport.queuedRecordCount).toBe(0)
    expect(transport.queuedDecodedBytes).toBe(0)
  })

  it('decrements both counters as queued records drain normally', async () => {
    const socket = new ControlledDuplex()
    const transport = new FramedSocketTransport(socket, MAX_RECORD_BYTES, {
      maxRecords: 2,
      maxDecodedBytes: 1_024,
    })
    const first = { payload: 'first' }
    const second = { payload: 'second' }
    produce(socket, [first, second])
    await flushStreamEvents()
    const total = Buffer.byteLength(JSON.stringify(first), 'utf8') + Buffer.byteLength(JSON.stringify(second), 'utf8')
    expect(transport.queuedDecodedBytes).toBe(total)

    await expect(transport.receive()).resolves.toEqual(first)
    expect(transport.queuedRecordCount).toBe(1)
    expect(transport.queuedDecodedBytes).toBe(Buffer.byteLength(JSON.stringify(second), 'utf8'))
    await expect(transport.receive()).resolves.toEqual(second)
    expect(transport.queuedRecordCount).toBe(0)
    expect(transport.queuedDecodedBytes).toBe(0)
    transport.close()
  })

  it('rejects pending reads on malformed input and pending writes on EOF', async () => {
    const malformedSocket = new ControlledDuplex()
    const malformedTransport = new FramedSocketTransport(malformedSocket, MAX_RECORD_BYTES)
    const pendingRead = malformedTransport.receive()
    malformedSocket.push(Buffer.from([1, 0, 0, 0, 0xff]))
    await expect(pendingRead).rejects.toThrowError(/UTF-8 JSON/u)
    expect(malformedTransport.queuedDecodedBytes).toBe(0)

    const eofSocket = new ControlledDuplex()
    eofSocket.stallWrites = true
    const eofTransport = new FramedSocketTransport(eofSocket, MAX_RECORD_BYTES)
    const pendingWrite = eofTransport.send({ pending: true })
    eofSocket.push(null)
    await expect(pendingWrite).rejects.toThrowError(/EOF|closed|destroyed/ui)
    expect(eofTransport.queuedRecordCount).toBe(0)
    expect(eofTransport.queuedDecodedBytes).toBe(0)
  })
})
