/** Prefix for catalog rows intentionally ahead of installed Pi upstream. */
export const PENDING_PI_UPSTREAM_NOTE_PREFIX = 'Pending Pi upstream'

export function isPendingPiUpstreamDivergence(notes) {
  return typeof notes === 'string' && notes.trim().toLowerCase().startsWith(PENDING_PI_UPSTREAM_NOTE_PREFIX.toLowerCase())
}

export function classifyMissingUpstreamModel(model) {
  if (!model?.piUpstreamId) {
    return 'fail'
  }

  if (isPendingPiUpstreamDivergence(model.intentionalDivergenceNotes)) {
    return 'pending'
  }

  return typeof model.intentionalDivergenceNotes === 'string' && model.intentionalDivergenceNotes.trim()
    ? 'intentional'
    : 'fail'
}
