const GPT5_MODEL_SPECIFIC_INSTRUCTIONS = `Return the requested sections only, in the requested order.
Prefer terse answers by default; expand only when depth materially helps.
Avoid restating large internal plans when the next action is already clear.
Prefer commas, periods, or parentheses over em dashes in normal prose.
Do not use em dashes unless the user explicitly asks for them or quoted text requires them.

Start the real work in the same turn when the next step is clear.
Do prerequisite lookup or discovery before dependent actions.
Use proportional effort: take another action when it materially reduces user-relevant risk or is required for acceptance, not merely because marginal improvement is possible.
Multi-part requests stay incomplete until every requested item is handled, explicitly agreed out of scope, or clearly marked blocked.
Once the acceptance criteria are met and no material blocker remains, stop; do not start another review wave by default.
Before the final answer, perform one focused check of correctness, coverage, formatting, and obvious side effects.`;

const CLAUDE_MODEL_SPECIFIC_INSTRUCTIONS = `Prefer concise, direct answers over essay-style framing.
Lead with the result, decision, or status first, then give only the supporting detail the user needs.
Avoid repeating obvious context from the user's latest message.
When uncertainty matters, distinguish verified facts from proposed next steps.

Do not stop at a summary when a concrete next action is required for the requested outcome.
For multi-part requests, handle every requested part or clearly mark what remains blocked or explicitly agreed out of scope.
Use proportional effort and stop once acceptance criteria are met; do not add review rounds for marginal completeness.
When evidence is sufficient, state the conclusion plainly instead of over-hedging.
Before finishing, perform one focused check that the response matches the requested format and that tool or file results support the claims.`;

export function getBuiltInModelSpecificInstructions(familyId: string): string | null {
  const normalizedFamilyId = familyId.trim().toLowerCase();

  if (!normalizedFamilyId) {
    return null;
  }

  if (
    normalizedFamilyId.startsWith('pi-codex') ||
    normalizedFamilyId.startsWith('pi-5.4') ||
    normalizedFamilyId.startsWith('pi-5.5') ||
    normalizedFamilyId.startsWith('pi-5.6')
  ) {
    return GPT5_MODEL_SPECIFIC_INSTRUCTIONS;
  }

  if (
    normalizedFamilyId.startsWith('pi-opus') ||
    normalizedFamilyId.startsWith('pi-sonnet') ||
    normalizedFamilyId.startsWith('sdk-opus') ||
    normalizedFamilyId.startsWith('sdk-sonnet')
  ) {
    return CLAUDE_MODEL_SPECIFIC_INSTRUCTIONS;
  }

  return null;
}
