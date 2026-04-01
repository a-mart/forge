import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PINS_PER_SESSION,
  clearAllPins,
  combineCompactionCustomInstructions,
  formatPinnedMessagesForCompaction,
  loadPins,
  savePins,
  togglePin,
  type PinRegistry,
} from '../swarm/message-pins.js'

describe('message-pins', () => {
  it('loads empty registry when sidecar is missing or corrupt', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))

    await expect(loadPins(sessionDir)).resolves.toEqual({ version: 1, pins: {} })

    await writeFile(join(sessionDir, 'pinned-messages.json'), '{not-json', 'utf8')
    await expect(loadPins(sessionDir)).resolves.toEqual({ version: 1, pins: {} })
  })

  it('saves and toggles pins with content preservation', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))

    await savePins(sessionDir, { version: 1, pins: {} })
    await togglePin(sessionDir, 'msg-1', true, {
      role: 'user',
      text: 'Keep this exact wording',
      timestamp: '2026-03-27T14:30:00.000Z',
    })

    const registry = await loadPins(sessionDir)
    expect(registry.pins['msg-1']).toMatchObject({
      role: 'user',
      text: 'Keep this exact wording',
      timestamp: '2026-03-27T14:30:00.000Z',
    })

    await togglePin(sessionDir, 'msg-1', false)
    await expect(loadPins(sessionDir)).resolves.toEqual({ version: 1, pins: {} })
  })

  it('enforces the max pin limit only when adding a new pin', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))
    const pins: PinRegistry['pins'] = {}

    for (let index = 0; index < MAX_PINS_PER_SESSION; index += 1) {
      pins[`msg-${index}`] = {
        pinnedAt: `2026-03-27T14:${String(index).padStart(2, '0')}:00.000Z`,
        role: 'assistant',
        text: `Pinned ${index}`,
        timestamp: `2026-03-27T14:${String(index).padStart(2, '0')}:00.000Z`,
      }
    }

    await savePins(sessionDir, { version: 1, pins })

    await expect(togglePin(sessionDir, 'msg-overflow', true, {
      role: 'user',
      text: 'one too many',
      timestamp: '2026-03-27T15:00:00.000Z',
    })).rejects.toThrow(`at most ${MAX_PINS_PER_SESSION} pinned messages`)

    await expect(togglePin(sessionDir, 'msg-0', true, {
      role: 'assistant',
      text: 'updated content',
      timestamp: '2026-03-27T15:01:00.000Z',
    })).resolves.toBeTruthy()
  })

  it('clears all pins and returns the previously pinned message ids', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))

    await savePins(sessionDir, {
      version: 1,
      pins: {
        'msg-1': {
          pinnedAt: '2026-03-27T14:30:00.000Z',
          role: 'user',
          text: 'Persist me',
          timestamp: '2026-03-27T14:30:00.000Z',
        },
        'msg-2': {
          pinnedAt: '2026-03-27T14:31:00.000Z',
          role: 'assistant',
          text: 'Persist me too',
          timestamp: '2026-03-27T14:31:00.000Z',
        },
      },
    })

    await expect(clearAllPins(sessionDir)).resolves.toEqual(['msg-1', 'msg-2'])
    await expect(loadPins(sessionDir)).resolves.toEqual({ version: 1, pins: {} })
    await expect(clearAllPins(sessionDir)).resolves.toEqual([])
  })

  it('formats pinned messages for compaction and avoids duplicate appends', async () => {
    const registry: PinRegistry = {
      version: 1,
      pins: {
        'msg-1': {
          pinnedAt: '2026-03-27T14:30:00.000Z',
          role: 'user',
          text: 'Please keep stderr logging.',
          timestamp: '2026-03-27T14:30:00.000Z',
        },
        'msg-2': {
          pinnedAt: '2026-03-27T14:32:00.000Z',
          role: 'assistant',
          text: 'Done. Updated handleError().',
          timestamp: '2026-03-27T14:32:00.000Z',
        },
      },
    }

    const formatted = formatPinnedMessagesForCompaction(registry)
    expect(formatted).toContain('## Preserved Messages (Pinned)')
    expect(formatted).toContain('### Pinned Message 1 (User, 2026-03-27 14:30):')
    expect(formatted).toContain('Please keep stderr logging.')
    expect(formatted).toContain('Done. Updated handleError().')

    const combined = combineCompactionCustomInstructions('Focus on deployment details.', registry)
    expect(combined).toContain('Focus on deployment details.')
    expect(combined).toContain('## Preserved Messages (Pinned)')
    expect(combineCompactionCustomInstructions(combined, registry)).toBe(combined)
  })

  it('serializes attachment metadata when pinning messages without meaningful text', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))

    await togglePin(sessionDir, 'msg-attachment', true, {
      role: 'assistant',
      text: '.',
      timestamp: '2026-03-27T16:00:00.000Z',
      attachments: [
        { type: 'image', mimeType: 'image/png', data: 'abc', fileName: 'image.png' },
        { type: 'binary', mimeType: 'application/pdf', data: 'xyz', filePath: '/tmp/document.pdf' },
      ],
    })

    const registry = await loadPins(sessionDir)
    expect(registry.pins['msg-attachment']).toMatchObject({
      text: '[Attached: image.png (image/png), document.pdf (application/pdf)]',
    })

    const formatted = formatPinnedMessagesForCompaction(registry)
    expect(formatted).toContain('[Attached: image.png (image/png), document.pdf (application/pdf)]')
  })

  it('writes valid json to the sidecar file', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'forge-message-pins-'))

    await savePins(sessionDir, {
      version: 1,
      pins: {
        'msg-1': {
          pinnedAt: '2026-03-27T14:30:00.000Z',
          role: 'user',
          text: 'Persist me',
          timestamp: '2026-03-27T14:30:00.000Z',
        },
      },
    })

    const raw = await readFile(join(sessionDir, 'pinned-messages.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      pins: {
        'msg-1': {
          role: 'user',
          text: 'Persist me',
        },
      },
    })
  })
})
