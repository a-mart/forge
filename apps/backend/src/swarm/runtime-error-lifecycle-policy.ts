import type { RuntimeErrorEvent } from "./runtime-contracts.js";

/**
 * Recovery progress is not a terminal manager-turn error. Keep the active
 * delivery/output context until Pi either resumes or reaches agent_settled.
 */
export function shouldPreserveActiveTurnForRuntimeError(error: RuntimeErrorEvent): boolean {
  if (error.details?.preserveActiveTurn === true) {
    return true;
  }

  if (error.phase !== "compaction" && error.phase !== "context_guard") {
    return false;
  }

  // A generic prompt failure may be classified as compaction-related without
  // being part of Forge's recovery lifecycle. Only an explicit recovery stage
  // is nonterminal; otherwise preserve the existing terminal-error behavior.
  if (typeof error.details?.recoveryStage !== "string") {
    return false;
  }

  return error.details?.compactionRecoveryTerminal !== true
    && error.details?.recoveryStage !== "recovery_failed";
}
