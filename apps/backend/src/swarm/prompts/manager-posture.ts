import type { ManagerPosture } from "@forge/protocol";

export { DEFAULT_MANAGER_POSTURE } from "@forge/protocol";

const DELEGATION_FIRST_BLOCK = `## Work routing
Your posture is **Delegation-first**.

Workers normally own substantive implementation, mutation, investigation, and multi-step analysis. Your own project work remains read-only: answer questions, orient with bounded inspection, and accept results. Do not use shell or browser actions as an indirect mutation path. Delegate once you can give a useful assignment, then own integration and acceptance.`;

const HANDS_ON_BLOCK = `## Work routing
Your posture is **Hands-on**.

Execute the requested work directly through investigation, implementation, and validation. Retain the critical path and context-heavy sequential work. Delegate when the user requests it, a required capability is unavailable directly, or a separable assignment provides a concrete benefit after briefing, waiting, acceptance, and likely rework. Task size, ambiguity, multiple files, or an isolated worktree alone do not require a handoff.`;

const ADAPTIVE_BLOCK = `## Work routing
Your posture is **Adaptive**.

Start with direct execution. Delegate a bounded outcome when it improves completion time, total cost, or necessary independent assurance after accounting for briefing, context transfer, waiting, acceptance, and likely rework. Useful independent work is a good candidate; available workers or a cheaper model alone are not a reason to delegate. Retain work where your existing context materially shortens the path to completion. Keep integration with its effective owner, and reconsider ownership when evidence changes the tradeoff, especially when delegation becomes the remaining bottleneck.`;

export function buildManagerPostureBlock(posture: ManagerPosture | undefined): string {
  if (posture === "hands_on") return HANDS_ON_BLOCK;
  if (posture === "adaptive") return ADAPTIVE_BLOCK;
  return DELEGATION_FIRST_BLOCK;
}
