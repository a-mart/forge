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
    retry: 'Retry',
  },
  /** First-launch onboarding modal. */
  onboarding: {
    title: 'Try the new Cortex',
    description:
      "Forge has a new way to remember what it learns. Instead of loading full memory files into every prompt, the new Cortex keeps each learning as its own entry and injects only a compact index — using far less context. Managers pull details on demand with the knowledge and save_learning tools.",
    revertNote: "It's opt-in, and you can switch back to the previous memory behavior anytime in Settings.",
    enable: 'Enable new Cortex',
    dismiss: 'Not now',
    enableError: 'Could not enable New Cortex. You can try again from Settings.',
  },
} as const
