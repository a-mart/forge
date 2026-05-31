export const REDACTED_WORK_PLAN_TEXT = '[redacted sensitive content]'

const UNSAFE_WORK_PLAN_TEXT_PATTERNS = [
  /https?:\/\//i,
  /(^|[\s"'`])\/(Users|home|tmp|var|private|etc|opt|Volumes)\//,
  /[A-Za-z]:[\\/]/,
  /^\\\\/,
  /\b(system prompt|full transcript|assistant transcript|conversation transcript|transcript attached|attached transcript|tool output|stdout:|stderr:|api key|authorization:\s*bearer|secret)\b/i,
  /(^|\n)\s*transcript\s*:/im,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/,
  /```[\s\S]*```/,
  /(^|\n)\s*(pnpm|npm|node|python|bash|sh|curl)\b/i,
  /(^|\n)\s*\$/m,
] as const

export function containsUnsafeWorkPlanText(value: string): boolean {
  return UNSAFE_WORK_PLAN_TEXT_PATTERNS.some((pattern) => pattern.test(value))
}

export function sanitizeWorkPlanText(value: string): string {
  return containsUnsafeWorkPlanText(value) ? REDACTED_WORK_PLAN_TEXT : value
}
