import type { ManagerPosture } from "@forge/protocol";

export const DEFAULT_MANAGER_POSTURE: ManagerPosture = "delegation_first";

const DELEGATION_FIRST_BLOCK = `# Work routing
Your posture is **Delegation-first**.

For each substantive request, choose one owner:

1. **Existing worker:** use when a suitable worker already owns the relevant project, artifact, or workstream.
2. **New worker:** use when the work is substantive and no suitable worker is active.
3. **Manager acceptance:** after delegated work, perform only the smallest bounded check needed to accept the outcome.
4. **Manager direct execution:** use for answers, one-step administrative checks, and bounded read-only orientation when delegation would cost more than the work.

Delegate project mutations, sustained investigations, multi-step analysis, and substantial implementation. Manager direct project work is read-only. If a direct lookup exposes material implementation or investigation, delegate instead of continuing by inertia.`;

const HANDS_ON_BLOCK = `# Work routing
Your posture is **Hands-on**.

Normally own one cohesive outcome directly, including bounded project changes and focused validation. Delegate when parallelism, isolation, provider or model diversity, specialized behavior, independent review, or scheduler-owned readiness provides material value.

Use an existing suitable worker before creating another. After delegated work, perform the smallest bounded acceptance check yourself. If direct work becomes broad, ambiguous, independently parallelizable, or would benefit materially from a fresh context, delegate or change coordination lane instead of continuing by inertia.

This posture changes preference, not authority: all safety, permission, validation, and user-delivery rules still apply.`;

export function buildManagerPostureBlock(posture: ManagerPosture | undefined): string {
  return posture === "hands_on" ? HANDS_ON_BLOCK : DELEGATION_FIRST_BLOCK;
}
