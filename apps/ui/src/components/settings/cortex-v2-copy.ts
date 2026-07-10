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
      'Use compact global and profile knowledge indexes in prompts while keeping this session’s working memory. Legacy common and profile memory stay preserved but are not injected in this mode.',
    revertNote: 'Turning this off restores legacy common, profile, and session prompt context without deleting Knowledge v2 data.',
    unavailableNote: 'New Cortex settings are only available on the local Builder backend.',
    loadError: 'Could not load New Cortex settings',
    updateError: 'Failed to update New Cortex setting',
    migrationRequired: 'Migration required before New Cortex can be enabled. Ask the Forge operator to complete the guarded migration; this toggle does not migrate data.',
    retry: 'Retry',
  },
  /** First-launch onboarding modal. */
  onboarding: {
    title: 'Try the new Cortex',
    description:
      "Knowledge v2 keeps durable learning as individual global or profile entries. Prompts receive compact indexes plus this session’s working memory, and managers pull entry details on demand with the knowledge tool.",
    revertNote: "It's an opt-in preview. You can switch back to legacy common, profile, and session prompt context without deleting Knowledge v2 data.",
    enable: 'Enable new Cortex',
    dismiss: 'Not now',
    migrationRequired: 'Migration required. Ask the Forge operator to complete the guarded migration; onboarding cannot migrate or enable it yet.',
    enableError: 'Could not enable New Cortex. You can try again from Settings.',
  },
} as const
