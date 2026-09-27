import { useCallback, useEffect, useRef } from 'react'
import type { SessionReferenceDragData } from '@/lib/session-reference-drag'

interface UseSessionReferencesOptions {
  draftKey: string | undefined
  inputRef: React.RefObject<string>
  setInputWithDraft: (value: string) => void
}

/**
 * Tracks sessions dropped into the composer as `[@label]` mention tokens. Only tokens still
 * present in the sent text resolve to agent ids, so deleting a chip drops the reference.
 */
export function useSessionReferences({
  draftKey,
  inputRef,
  setInputWithDraft,
}: UseSessionReferencesOptions) {
  const agentIdByLabelRef = useRef(new Map<string, string>())

  useEffect(() => {
    agentIdByLabelRef.current = new Map()
  }, [draftKey])

  const addSessionReference = useCallback(
    ({ agentId, label }: SessionReferenceDragData, textarea: HTMLTextAreaElement | null) => {
      const references = agentIdByLabelRef.current
      const baseLabel = label.replace(/[[\]]/g, '').trim() || agentId
      let uniqueLabel = baseLabel
      for (let suffix = 2; references.has(uniqueLabel) && references.get(uniqueLabel) !== agentId; suffix += 1) {
        uniqueLabel = `${baseLabel} (${suffix})`
      }
      references.set(uniqueLabel, agentId)

      const input = inputRef.current
      const cursor = Math.min(textarea?.selectionStart ?? input.length, input.length)
      const before = input.slice(0, cursor)
      const after = input.slice(cursor)
      const token = `${before && !/\s$/.test(before) ? ' ' : ''}[@${uniqueLabel}] `
      setInputWithDraft(`${before}${token}${after}`)
      const nextCursor = cursor + token.length
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(nextCursor, nextCursor)
      })
    },
    [inputRef, setInputWithDraft],
  )

  const resolveSessionReferenceAgentIds = useCallback((text: string): string[] => {
    const agentIds = new Set<string>()
    for (const [label, agentId] of agentIdByLabelRef.current) {
      if (text.includes(`[@${label}]`)) agentIds.add(agentId)
    }
    return [...agentIds]
  }, [])

  return { addSessionReference, resolveSessionReferenceAgentIds }
}
