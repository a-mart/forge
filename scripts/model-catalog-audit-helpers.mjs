/** Prefix for catalog rows intentionally ahead of installed Pi upstream. */
export const PENDING_PI_UPSTREAM_NOTE_PREFIX = 'Pending Pi upstream'

export function isPendingPiUpstreamDivergence(notes) {
  return typeof notes === 'string' && notes.trim().toLowerCase().startsWith(PENDING_PI_UPSTREAM_NOTE_PREFIX.toLowerCase())
}

export function classifyMissingUpstreamModel(model) {
  if (!model?.piUpstreamId) {
    return 'fail'
  }

  return isPendingPiUpstreamDivergence(model.intentionalDivergenceNotes) ? 'pending' : 'fail'
}
