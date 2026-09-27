/** Drag payload for referencing a local manager session from the sidebar in a chat composer. */
export const SESSION_REFERENCE_DRAG_TYPE = 'application/x-forge-session-reference'

export interface SessionReferenceDragData {
  agentId: string
  label: string
}

export function writeSessionReferenceDrag(dataTransfer: DataTransfer, data: SessionReferenceDragData): void {
  dataTransfer.setData(SESSION_REFERENCE_DRAG_TYPE, JSON.stringify(data))
  dataTransfer.setData('text/plain', `@${data.label}`)
  dataTransfer.effectAllowed = 'copy'
}

export function hasSessionReferenceDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return dataTransfer?.types.includes(SESSION_REFERENCE_DRAG_TYPE) ?? false
}

export function readSessionReferenceDrag(dataTransfer: DataTransfer): SessionReferenceDragData | null {
  try {
    const parsed = JSON.parse(dataTransfer.getData(SESSION_REFERENCE_DRAG_TYPE)) as Partial<SessionReferenceDragData>
    return typeof parsed.agentId === 'string' && parsed.agentId && typeof parsed.label === 'string'
      ? { agentId: parsed.agentId, label: parsed.label }
      : null
  } catch {
    return null
  }
}
