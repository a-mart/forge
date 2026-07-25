---
activation: explicit-or-autonomous
confirmWhenAutonomous: true
synthesisOwner: manager
synthesisStrategy: claim-challenge-resolution
anonymizeContributors: true
preserveDisagreement: true
---

# Adversarial Review

Use for a consequential proposal, architecture, remediation, or implementation where independent
challenge can materially change the decision. Do not use as a ceremonial second review for ordinary
work.

## Design

- Give reviewers different failure questions, not different titles for the same prompt.
- Supply the same frozen artifact or exact ref to each reviewer.
- Require reproducible evidence and distinguish blocker, verification gap, and improvement.
- Keep the original author out of the initial reviewer context when practical.

## Example graph

```json
{
  "explanation": "Challenge the same frozen proposal from independent failure lenses.",
  "maxConcurrency": 3,
  "nodes": [
    {
      "id": "challenge-correctness",
      "title": "Challenge correctness",
      "task": "Review the frozen proposal for invalid assumptions, edge cases, and contract violations. Return only reproducible findings, evidence, and severity.",
      "kind": "review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "Every finding names the violated invariant and includes focused evidence or a concrete reproduction.",
      "route": "auto"
    },
    {
      "id": "challenge-operations",
      "title": "Challenge operability",
      "task": "Review the frozen proposal for deployment, recovery, observability, compatibility, and failure-mode risks. Return evidence and concrete mitigations.",
      "kind": "design-review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result covers operational failure and recovery with evidence, not generic concerns.",
      "route": "auto"
    },
    {
      "id": "challenge-simplicity",
      "title": "Challenge complexity",
      "task": "Search for unnecessary abstraction, duplicate authority, migration burden, and a simpler design that preserves the outcome. Return concrete alternatives and tradeoffs.",
      "kind": "design-review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result identifies specific removable complexity or explains why the design is already minimal.",
      "route": "auto"
    }
  ]
}
```

## Synthesis

Normalize findings by claim, not reviewer. Deduplicate shared evidence, resolve contradictions with
the smallest focused check, and retain dissent when evidence remains incomplete. A majority opinion
does not override stronger evidence.

## Adaptation

Use two reviewers for a bounded risk surface. Add security or privacy as a distinct lens only when
the artifact has that attack surface; do not append every possible review category by default.
