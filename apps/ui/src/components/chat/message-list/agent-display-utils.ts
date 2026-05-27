import type { AgentDescriptor } from '@forge/protocol'

/** Resolved display metadata for an agent, suitable for rendering in tool/message rows. */
export interface AgentDisplayMeta {
  agentId: string
  /** Human-readable primary label: displayName or agentId fallback. */
  primaryLabel: string
  /** Secondary metadata line: specialist, model/provider, reasoning level. */
  secondaryLabel: string | null
  /** Specialist color for optional visual accent. */
  specialistColor: string | null
  /** Full title including raw agentId and all metadata for tooltip/audit. */
  title: string
}

/**
 * Build an AgentDisplayMeta lookup map from agent descriptors.
 * Returns a Map keyed by agentId for O(1) access during render.
 */
export function buildAgentDisplayMap(agents: AgentDescriptor[]): Map<string, AgentDisplayMeta> {
  const map = new Map<string, AgentDisplayMeta>()

  for (const agent of agents) {
    const primaryLabel = agent.displayName?.trim() || agent.agentId
    const parts: string[] = []

    if (agent.specialistDisplayName?.trim()) {
      parts.push(agent.specialistDisplayName.trim())
    }

    if (agent.model) {
      const modelParts: string[] = []
      if (agent.model.provider) modelParts.push(agent.model.provider)
      if (agent.model.modelId) modelParts.push(agent.model.modelId)
      if (modelParts.length > 0) parts.push(modelParts.join('/'))

      if (agent.model.thinkingLevel && agent.model.thinkingLevel !== 'none') {
        parts.push(agent.model.thinkingLevel)
      }
    }

    const secondaryLabel = parts.length > 0 ? parts.join(' · ') : null

    const titleParts = [agent.agentId]
    if (primaryLabel !== agent.agentId) titleParts.push(primaryLabel)
    if (secondaryLabel) titleParts.push(secondaryLabel)

    map.set(agent.agentId, {
      agentId: agent.agentId,
      primaryLabel,
      secondaryLabel,
      specialistColor: agent.specialistColor?.trim() || null,
      title: titleParts.join(' — '),
    })
  }

  return map
}
