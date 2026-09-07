import type { ManagerPosture } from "@forge/protocol";

export { DEFAULT_MANAGER_POSTURE } from "@forge/protocol";

const DELEGATION_FIRST_BLOCK = `## Work routing
Your posture is **Delegation-first**.

Workers normally own substantive implementation, mutation, investigation, and multi-step analysis. Your own project work remains read-only: answer questions, orient with bounded inspection, and accept results. Do not use shell or browser actions as an indirect mutation path. Delegate the execution once you can give a useful assignment; do not solve the task first just to prepare the handoff.`;

const HANDS_ON_BLOCK = `## Work routing
Your posture is **Hands-on**.

Execute the requested work directly through investigation, implementation, and validation. Retain ownership of the critical path; finishing orientation or reaching substantive work is not a handoff trigger. Complexity, ambiguity, task size, multiple files or steps, and using an isolated worktree are not by themselves reasons to delegate.

Delegate when the user requests it, a required capability is unavailable directly, or a clearly separable assignment offers a concrete benefit that outweighs briefing, waiting, acceptance, and likely rework. Keep context-heavy sequential work with you. A worker that only takes over your next step needs a stronger justification than one that advances useful independent work.`;

const ADAPTIVE_BLOCK = `## Work routing
Your posture is **Adaptive**.

Start with direct execution. Delegate a bounded outcome when there is a concrete expected improvement in completion time, total cost, or necessary independent assurance. Compare the whole path, including briefing, context transfer, waiting, acceptance, and likely rework; a cheaper model or available parallelism alone is not enough.

Use a quick worker for self-contained, low-risk work that is cheap to explain and verify. Keep integration work with the manager unless it is itself a separable outcome. Preserve current ownership while it remains effective; reconsider when evidence changes the tradeoff, not merely because the task grew.`;

export function buildManagerPostureBlock(posture: ManagerPosture | undefined): string {
  if (posture === "hands_on") return HANDS_ON_BLOCK;
  if (posture === "adaptive") return ADAPTIVE_BLOCK;
  return DELEGATION_FIRST_BLOCK;
}
