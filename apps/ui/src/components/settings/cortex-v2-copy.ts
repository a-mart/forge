/**
 * Centralized copy + constants for the "New Cortex (Knowledge v2)" feature.
 *
 * Both the Settings toggle and the first-launch onboarding modal read their
 * user-facing strings from here so the lead can refine wording in one place.
 */

/**
 * localStorage key recording that the user has seen / decided on the
 * first-launch Cortex v2 onboarding prompt.  Bumping the version suffix would
 * re-show the prompt to everyone; keep it stable unless that is intended.
 */
export const CORTEX_V2_ONBOARDING_SEEN_KEY = 'forge.cortexV2OnboardingSeen'

export const CORTEX_V2_COPY = {
  /** Settings → General, Cortex section. */
  settings: {
    label: 'New Cortex (Knowledge v2)',
    description:
      'Store what Forge learns as individual knowledge entries and inject only a compact index into prompts, instead of the full memory files.',
    revertNote: 'Turning this off reverts to the previous memory behavior.',
    unavailableNote: 'New Cortex settings are only available on the local Builder backend.',
    loadError: 'Could not load New Cortex settings',
    updateError: 'Failed to update New Cortex setting',
    migrationRequired: 'Migration required before New Cortex can be enabled. Activation is unavailable in the UI until the guarded migration has completed.',
    retry: 'Retry',
  },
  /** Settings → General, Cortex consolidation schedule (cortex-auto-review API). */
  consolidation: {
    sectionDescription:
      'Cortex maintains knowledge entries and a compact index used when Knowledge v2 is enabled.',
    toggleLabel: 'Automatic Consolidation',
    toggleDescription:
      'When enabled, Cortex periodically merges, archives, and reindexes knowledge entries. Consolidation only runs while Knowledge v2 is enabled.',
    cadenceLabel: 'Consolidation Cadence',
    cadenceDescription: 'Consolidation runs once per day while Knowledge v2 is enabled.',
    cadenceValue: 'Every 24 hours',
  },
  /** First-launch onboarding modal. */
  onboarding: {
    title: 'Try the new Cortex',
    description:
      "Forge has a new way to remember what it learns. Instead of loading full memory files into every prompt, the new Cortex keeps each learning as its own entry and injects only a compact index — using far less context. Managers pull details on demand with the knowledge and save_learning tools.",
    revertNote: "It's opt-in, and you can switch back to the previous memory behavior anytime in Settings.",
    enable: 'Enable new Cortex',
    dismiss: 'Not now',
    migrationRequired: 'Migration required. Forge cannot safely enable the new Cortex until the guarded migration has completed.',
    enableError: 'Could not enable New Cortex. You can try again from Settings.',
  },
} as const
