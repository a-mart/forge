import { closeSync, openSync, readSync } from 'node:fs'
import type { HistoryEntryReference } from '@forge/protocol'
import { projectCanonicalLine } from './canonical-projector.js'
import { MAX_LINE_BYTES } from './content-policy.js'
import { readSourceGeneration, readSourceStat } from './jsonl-reader.js'

const MAX_CHECKPOINT_SCAN_BYTES = 8 * 1024 * 1024

/** Native runtime only: locate recent persisted evidence without waiting for the derived index. */
export function locateCheckpointEvidence(options: {
  sessionFile: string
  sessionAgentId: string
  actorAgentId: string
  entryIds: readonly string[]
}): { refs: HistoryEntryReference[]; missingIds: string[] } {
  const wanted = new Set(options.entryIds.slice(-32))
  const refs: HistoryEntryReference[] = []
  if (!wanted.size) return { refs, missingIds: [] }
  const stat = readSourceStat(options.sessionFile)
  if (!stat) return { refs, missingIds: [...wanted] }
  const sourceVersion = readSourceGeneration(options.sessionFile, stat)
  const start = Math.max(0, stat.size - MAX_CHECKPOINT_SCAN_BYTES)
  const fd = openSync(options.sessionFile, 'r')
  try {
    const bytes = Buffer.alloc(stat.size - start)
    const length = readSync(fd, bytes, 0, bytes.length, start)
    const data = bytes.subarray(0, length)
    let position = start === 0 ? 0 : data.indexOf(10) + 1
    if (start > 0 && position === 0) return { refs, missingIds: [...wanted] }
    while (position < data.length) {
      const end = data.indexOf(10, position)
      if (end < 0) break
      if (end - position <= MAX_LINE_BYTES) {
        const line = data.subarray(position, end).toString('utf8')
        let id: unknown
        try { id = JSON.parse(line)?.id } catch { /* incomplete/malformed history is not evidence */ }
        if (typeof id === 'string' && wanted.has(id)) {
          const entry = projectCanonicalLine(line, start + position, { windowId: 'window:checkpoint-evidence', seenContentKeys: new Map() }, 'read')
          if (entry) {
            refs.push({ sessionAgentId: options.sessionAgentId, actorAgentId: options.actorAgentId, entryId: id, sourceVersion, byteOffset: start + position })
            wanted.delete(id)
          }
        }
      }
      position = end + 1
    }
  } finally { closeSync(fd) }
  return { refs, missingIds: [...wanted] }
}
