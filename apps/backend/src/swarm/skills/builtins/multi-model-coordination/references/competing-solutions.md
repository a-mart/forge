---
activation: explicit-or-autonomous
confirmWhenAutonomous: true
synthesisOwner: manager
synthesisStrategy: constraint-weighted-comparison
anonymizeContributors: true
preserveDisagreement: true
---

# Competing Solutions

Use when an ambiguous problem has multiple plausible solution families and choosing too early would
hide meaningful tradeoffs. Do not use when constraints already determine one straightforward
implementation.

## Design

- Give each leaf the same outcome, constraints, and acceptance target.
- Assign distinct solution constraints: minimal change, architectural fit, or operational safety.
- Require an implementation sketch, migration impact, risks, and validation plan.
- Avoid parallel writes. Candidates propose; implementation starts after selection.

## Example graph

```json
{
  "explanation": "Develop independent candidates under different constraints before selecting one.",
  "maxConcurrency": 3,
  "nodes": [
    {
      "id": "candidate-minimal",
      "title": "Design minimal candidate",
      "task": "Design the smallest change that achieves the stated outcome. Include touched seams, compatibility, risks, and focused validation. Do not implement.",
      "kind": "plan",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The candidate is concrete, preserves stated invariants, and identifies its tradeoffs.",
      "route": "auto"
    },
    {
      "id": "candidate-structural",
      "title": "Design structural candidate",
      "task": "Design a clean structural solution optimized for long-term authority and maintainability. Include migration cost, risks, and focused validation. Do not implement.",
      "kind": "plan",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The candidate is concrete and explains why its added structure earns its cost.",
      "route": "auto"
    },
    {
      "id": "candidate-operational",
      "title": "Design operational candidate",
      "task": "Design a solution optimized for rollout safety, recovery, and observability. Include compatibility, failure handling, and focused validation. Do not implement.",
      "kind": "plan",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The candidate is concrete and proves how rollout and recovery risks are controlled.",
      "route": "auto"
    }
  ]
}
```

## Synthesis

Compare candidates against explicit constraints before reading their recommendations. Select one,
combine compatible elements only when that does not create a third bloated design, and state why the
rejected complexity is not justified. Verify the decisive feasibility claim.

## Adaptation

Two candidates are usually enough. Use provider or model diversity when the active roster offers it,
but choose routes by their current guidance rather than hardcoding provider names.
