import type { ManagerReasoningLevel } from '@forge/protocol'

const DEFAULT_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  ultra: 'Ultra',
}

/**
 * Format a reasoning level for a model-aware selector.
 *
 * Historically xhigh was rendered as Max. Keep that label for models whose
 * supported range stops at xhigh, while distinguishing xhigh from max when a
 * model exposes both levels (for example Claude Opus 5).
 */
export function formatReasoningLevel(
  level: string,
  supportedLevels?: readonly string[],
): string {
  const normalized = level === 'x-high' ? 'xhigh' : level
  if (normalized === 'xhigh') {
    return supportedLevels?.includes('max') ? 'Extra High' : 'Max'
  }

  const knownLabel = DEFAULT_LABELS[normalized]
  if (knownLabel) return knownLabel

  const words = normalized.replaceAll(/[-_]+/g, ' ').trim()
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : 'Default'
}

export function formatManagerReasoningLevel(
  level: ManagerReasoningLevel,
  supportedLevels?: readonly ManagerReasoningLevel[],
): string {
  return formatReasoningLevel(level, supportedLevels)
}
