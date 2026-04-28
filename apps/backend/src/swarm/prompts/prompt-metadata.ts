/**
 * Static metadata registry for all centralized prompts.
 *
 * This module defines display names, descriptions, and variable declarations
 * for every prompt managed by the PromptRegistry. The `.md` template files
 * stay clean (no YAML frontmatter) — all discoverability metadata lives here.
 *
 * Canonical type definitions for PromptCategory, PromptSourceLayer, and
 * PromptVariableDeclaration live in `@forge/protocol` (shared-types).
 */

import type { PromptCategory, PromptSourceLayer, PromptVariableDeclaration } from "@forge/protocol";

interface PromptMetadataEntry {
  category: PromptCategory;
  promptId: string;
  displayName: string;
  description: string;
  variables: PromptVariableDeclaration[];
  /**
   * When set, this prompt is only shown/relevant for the specified profile.
   * Omit for prompts that apply to all profiles.
   */
  profileScope?: string;
}

/**
 * Complete metadata for every known prompt.
 *
 * The list is authoritative: if a promptId is not listed here, the HTTP API
 * will reject save/delete operations for it (you can't create arbitrary new
 * prompts via the REST endpoints).
 */
export const PROMPT_METADATA: PromptMetadataEntry[] = [
  // ── Archetypes ──────────────────────────────────────────────
  {
    category: 'archetype',
    promptId: 'manager',
    displayName: 'Manager System Prompt',
    description:
      'Core instructions for all manager agents. Defines delegation protocol, communication rules, and safety constraints.',
    variables: [
      { name: 'SWARM_MEMORY_FILE', description: "Path to the agent's memory file" },
    ],
  },
  {
    category: 'archetype',
    promptId: 'worker',
    displayName: 'Default Worker System Prompt',
    description:
      'Fallback instructions for workers without a custom system prompt or archetype.',
    variables: [
      { name: 'SWARM_MEMORY_FILE', description: "Path to the agent's memory file" },
    ],
  },
  {
    category: 'archetype',
    promptId: 'cortex',
    displayName: 'Cortex System Prompt',
    description: 'Instructions for the Cortex intelligence/knowledge manager.',
    profileScope: 'cortex',
    variables: [
      { name: 'SWARM_DATA_DIR', description: 'Path to the Forge data directory' },
      { name: 'SWARM_MEMORY_FILE', description: 'Path to the memory file' },
      { name: 'SWARM_SCRIPTS_DIR', description: 'Path to the scripts directory' },
    ],
  },
  {
    category: 'archetype',
    promptId: 'merger',
    displayName: 'Merger Worker System Prompt',
    description: 'Instructions for branch-merge worker agents.',
    variables: [],
  },
  {
    category: 'archetype',
    promptId: 'collaboration-channel',
    displayName: 'Collaboration Channel System Prompt',
    description: 'Instructions for manager sessions that back collaboration channels.',
    variables: [
      {
        name: 'MODEL_SPECIFIC_INSTRUCTIONS',
        description: 'Model-specific manager instructions injected from the model catalog.',
      },
      {
        name: 'SPECIALIST_ROSTER',
        description: 'Specialist roster block injected into manager prompts when specialists are enabled.',
      },
    ],
  },

  // ── Operational ─────────────────────────────────────────────
  {
    category: 'operational',
    promptId: 'bootstrap',
    displayName: 'Manager Bootstrap Message',
    description: 'First message sent to newly created managers to drive project bootstrap, not person-level onboarding.',
    variables: [],
  },
  {
    category: 'operational',
    promptId: 'memory-merge',
    displayName: 'Memory Merge System Prompt',
    description:
      'System prompt for the LLM call that merges session memory into profile memory.',
    variables: [],
  },
  {
    category: 'operational',
    promptId: 'memory-template',
    displayName: 'Default Memory Template',
    description:
      'Initial content for new memory files. Source: persistence-service.ts DEFAULT_MEMORY_FILE_CONTENT.',
    variables: [],
  },
  {
    category: 'operational',
    promptId: 'common-knowledge-template',
    displayName: 'Common Knowledge Template',
    description:
      'Initial content for shared/knowledge/common.md when Cortex profile is created.',
    profileScope: 'cortex',
    variables: [],
  },
  {
    category: 'operational',
    promptId: 'cortex-worker-prompts',
    displayName: 'Cortex Worker Prompt Templates',
    description:
      'Templates Cortex uses when spawning extraction/review/synthesis workers.',
    profileScope: 'cortex',
    variables: [],
  },
  {
    category: 'operational',
    promptId: 'forked-session-header',
    displayName: 'Forked Session Memory Header',
    description: 'Header written to new session memory file when forking a session.',
    variables: [
      { name: 'SOURCE_LABEL', description: 'Display name of the source session' },
      { name: 'SOURCE_AGENT_ID', description: 'Agent ID of the source session' },
      { name: 'FORK_TIMESTAMP', description: 'ISO timestamp of the fork' },
    ],
  },
  {
    category: 'operational',
    promptId: 'idle-watchdog',
    displayName: 'Idle Worker Watchdog Message',
    description: 'Warning sent when workers go idle without reporting back.',
    variables: [
      { name: 'WORKER_COUNT', description: 'Number of idle workers' },
      { name: 'WORKER_IDS', description: 'Comma-separated list of idle worker IDs' },
    ],
  },
];

/**
 * Fast lookup by composite key "category:promptId".
 */
const METADATA_INDEX = new Map<string, PromptMetadataEntry>(
  PROMPT_METADATA.map((entry) => [`${entry.category}:${entry.promptId}`, entry]),
);

/**
 * Returns metadata for a specific prompt, or `undefined` if the promptId
 * is not a known centralized prompt.
 */
export function getPromptMetadata(
  category: PromptCategory,
  promptId: string,
): PromptMetadataEntry | undefined {
  return METADATA_INDEX.get(`${category}:${promptId}`);
}

/**
 * Returns true when the (category, promptId) pair is a recognized prompt.
 */
export function isKnownPrompt(category: PromptCategory, promptId: string): boolean {
  return METADATA_INDEX.has(`${category}:${promptId}`);
}

/**
 * Type guard for PromptCategory strings.
 */
export function isValidPromptCategory(value: string): value is PromptCategory {
  return value === 'archetype' || value === 'operational';
}

/**
 * Type guard for PromptSourceLayer strings.
 */
export function isValidPromptSourceLayer(value: string): value is PromptSourceLayer {
  return value === 'profile' || value === 'repo' || value === 'builtin';
}
