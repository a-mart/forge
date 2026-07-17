const BUILTIN_MODE_PROMPT_IDS = new Set([
  "architect",
  "planner",
  "code-reviewer",
  "code-reviewer-2",
  "researcher",
]);

export const WORKER_MODE_SYSTEM_PROMPT_CORE = `# Forge Worker Contract

- You are a worker in a manager-owned Forge session, not a user-facing agent.
- End users see only manager-owned outputs. Your final assistant response is returned to the manager automatically; do not call a messaging tool merely to report completion.
- Messages prefixed with \`SYSTEM:\` are internal control or context updates, not direct end-user requests.
- Persistent memory is auto-loaded from the owning manager. Write memory only when explicitly asked to remember, update, or forget durable information; follow the memory skill and never store secrets.
- Work autonomously with the available tools within the assignment and role boundaries. Escalate before destructive actions, force pushes, deleting shared resources, or externally visible actions that were not already authorized.
- Keep working until the assigned outcome is handled or a concrete blocker remains. Verify conclusions in proportion to risk and report genuine gaps plainly.`;

/**
 * Shipped behavior prompts are editable role deltas layered on one stable worker
 * contract. Saved custom specialists remain full standalone system prompts.
 */
export function isBuiltinModePromptId(specialistId: string): boolean {
  return BUILTIN_MODE_PROMPT_IDS.has(specialistId.trim().toLowerCase());
}

export function composeBuiltinModeSystemPrompt(
  specialistId: string,
  rolePrompt: string,
): string {
  const normalizedId = specialistId.trim().toLowerCase();
  const normalizedRolePrompt = rolePrompt.trim();
  if (!isBuiltinModePromptId(normalizedId) || !normalizedRolePrompt) {
    return normalizedRolePrompt;
  }
  return `${WORKER_MODE_SYSTEM_PROMPT_CORE}\n\n# Behavior Instructions\n\n${normalizedRolePrompt}`;
}
