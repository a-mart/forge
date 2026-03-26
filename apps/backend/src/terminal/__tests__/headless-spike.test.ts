/**
 * Phase 0 spike findings for integrated terminal persistence.
 *
 * Works:
 * - `@xterm/headless` 6.0.0 creates and processes terminal state correctly in Node.
 * - `@xterm/addon-serialize` 0.14.0 loads into the headless terminal and produces replayable VT output.
 * - Snapshot -> restore -> re-serialize is stable, including colors, cursor movement effects, resize, and scrollback.
 *
 * Caveats:
 * - In Node ESM, both packages behave as CommonJS modules at runtime. Default-import the package and read exports off the default object; named ESM imports fail.
 * - `SerializeAddon.serialize()` touches the proposed buffer API internally, so headless terminals must be created with `allowProposedApi: true` for this pairing to work.
 * - Serialization is a canonical terminal-state snapshot, not a byte-for-byte copy of the original PTY stream. Cursor movement and overwrite sequences round-trip by final rendered state, not original escape bytes.
 * - The serialize addon recommends restoring into a terminal of the same size first, then resizing afterward.
 *
 * Version-specific notes:
 * - Validated in this worktree with `@xterm/headless` 6.0.0 + `@xterm/addon-serialize` 0.14.0 under Vitest/Node.
 *
 * Performance:
 * - Local baseline was single-digit milliseconds for serializing 1000 lines of scrollback; this test enforces a generous <50ms median threshold.
 *
 * Recommendation:
 * - Go for the planned `snapshot.vt` approach. Store serialize output as the canonical snapshot, replay it into a same-sized headless terminal during restore, and keep a separate raw delta journal if exact output history is needed.
 */

import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type * as HeadlessModule from '@xterm/headless'
import type * as SerializeModule from '@xterm/addon-serialize'
import headlessPkg from '@xterm/headless'
import serializePkg from '@xterm/addon-serialize'

const { Terminal } = headlessPkg as typeof HeadlessModule
const { SerializeAddon } = serializePkg as typeof SerializeModule

type HeadlessTerminal = InstanceType<typeof Terminal>
type HeadlessTerminalOptions = NonNullable<ConstructorParameters<typeof Terminal>[0]>
type HeadlessSerializeAddon = InstanceType<typeof SerializeAddon>
type SerializeOptions = Parameters<HeadlessSerializeAddon['serialize']>[0]

function createTerminal(
  options: Partial<HeadlessTerminalOptions> = {},
): { terminal: HeadlessTerminal; serializeAddon: HeadlessSerializeAddon } {
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 1000,
    allowProposedApi: true,
    ...options,
  })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  return { terminal, serializeAddon }
}

async function writeToTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(data, () => resolve())
  })
}

function snapshot(
  serializeAddon: HeadlessSerializeAddon,
  options?: SerializeOptions,
): string {
  return serializeAddon.serialize(options)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe('xterm headless serialize spike', () => {
  it('creates a headless terminal in Node and accepts writes', async () => {
    const { terminal, serializeAddon } = createTerminal()

    try {
      expect(terminal.cols).toBe(80)
      expect(terminal.rows).toBe(24)

      await writeToTerminal(terminal, 'hello from headless xterm')

      expect(snapshot(serializeAddon)).toBe('hello from headless xterm')
    } finally {
      terminal.dispose()
    }
  })

  it('loads SerializeAddon into a headless terminal and serializes content', async () => {
    const { terminal, serializeAddon } = createTerminal({ cols: 40, rows: 10 })

    try {
      await writeToTerminal(terminal, 'line one\r\nline two')

      expect(snapshot(serializeAddon)).toBe('line one\r\nline two')
    } finally {
      terminal.dispose()
    }
  })

  it('restores serialized state into a new terminal and re-serializes identically', async () => {
    const original = createTerminal({ cols: 80, rows: 24, scrollback: 200 })
    const restored = createTerminal({ cols: 80, rows: 24, scrollback: 200 })

    try {
      const input = Array.from({ length: 30 }, (_, index) => `row-${index + 1}\r\n`).join('')
      await writeToTerminal(original.terminal, input)

      const originalSnapshot = snapshot(original.serializeAddon, { scrollback: 200 })
      await writeToTerminal(restored.terminal, originalSnapshot)
      const restoredSnapshot = snapshot(restored.serializeAddon, { scrollback: 200 })

      expect(restoredSnapshot).toBe(originalSnapshot)
    } finally {
      original.terminal.dispose()
      restored.terminal.dispose()
    }
  })

  it('handles resize after writing content and still serializes without errors', async () => {
    const { terminal, serializeAddon } = createTerminal({ cols: 80, rows: 24, scrollback: 200 })

    try {
      await writeToTerminal(terminal, 'before resize\r\nafter resize prep')

      expect(() => terminal.resize(120, 40)).not.toThrow()

      await writeToTerminal(terminal, '\r\npost resize content')

      const resizedSnapshot = snapshot(serializeAddon, { scrollback: 200 })

      expect(resizedSnapshot).toContain('before resize')
      expect(resizedSnapshot).toContain('post resize content')
    } finally {
      terminal.dispose()
    }
  })

  it('captures scrollback beyond the visible viewport when requested', async () => {
    const { terminal, serializeAddon } = createTerminal({ cols: 20, rows: 3, scrollback: 20 })

    try {
      const input = Array.from({ length: 8 }, (_, index) => `L${index + 1}\r\n`).join('')
      await writeToTerminal(terminal, input)

      const scrollbackSnapshot = snapshot(serializeAddon, { scrollback: 2 })

      expect(scrollbackSnapshot).toContain('L5')
      expect(scrollbackSnapshot).toContain('L8')
      expect(scrollbackSnapshot).not.toContain('L4')
    } finally {
      terminal.dispose()
    }
  })

  it('serializes 1000 lines of scrollback under the 50ms baseline', async () => {
    const { terminal, serializeAddon } = createTerminal({ cols: 120, rows: 40, scrollback: 2000 })

    try {
      const input = Array.from(
        { length: 1000 },
        (_, index) => `line-${String(index).padStart(4, '0')} ${'x'.repeat(80)}\r\n`,
      ).join('')
      await writeToTerminal(terminal, input)

      snapshot(serializeAddon, { scrollback: 1000 })

      const samples: number[] = []
      for (let index = 0; index < 7; index += 1) {
        const start = performance.now()
        snapshot(serializeAddon, { scrollback: 1000 })
        samples.push(performance.now() - start)
      }

      expect(median(samples)).toBeLessThan(50)
    } finally {
      terminal.dispose()
    }
  })

  it('round-trips ANSI state canonically, including colors and cursor movement effects', async () => {
    const original = createTerminal({ cols: 40, rows: 5, scrollback: 100 })
    const restored = createTerminal({ cols: 40, rows: 5, scrollback: 100 })

    try {
      const ansiInput =
        'plain\r\n\u001b[31mred\u001b[0m normal\r\n12345\u001b[2DXY\r\n\u001b[2;5Hpos'

      await writeToTerminal(original.terminal, ansiInput)

      const originalSnapshot = snapshot(original.serializeAddon, { scrollback: 100 })
      await writeToTerminal(restored.terminal, originalSnapshot)
      const restoredSnapshot = snapshot(restored.serializeAddon, { scrollback: 100 })

      expect(originalSnapshot).toContain('\u001b[31mred\u001b[0m')
      expect(originalSnapshot).toContain('123XY')
      expect(originalSnapshot).toContain('posmal')
      expect(originalSnapshot).not.toBe(ansiInput)
      expect(restoredSnapshot).toBe(originalSnapshot)
    } finally {
      original.terminal.dispose()
      restored.terminal.dispose()
    }
  })
})
