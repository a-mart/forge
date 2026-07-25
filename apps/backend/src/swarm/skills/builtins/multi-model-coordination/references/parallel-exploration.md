---
activation: explicit-or-autonomous
confirmWhenAutonomous: false
synthesisOwner: manager
synthesisStrategy: evidence-matrix
anonymizeContributors: true
preserveDisagreement: true
---

# Parallel Exploration

Use when one outcome depends on two or more independent, non-overlapping investigations that can run
concurrently. Do not use when the investigations need the same mutable artifact or when one answer
must exist before the next question is knowable.

## Design

- Split by independent question, subsystem, source family, or risk.
- Give every leaf a bounded scope and a unique deliverable.
- Use a synthesis node only when the combined evidence is too large for bounded manager comparison.
- Keep shared writes out of exploration leaves.

## Example graph

```json
{
  "explanation": "Investigate independent dimensions in parallel, then compare accepted evidence.",
  "maxConcurrency": 3,
  "nodes": [
    {
      "id": "explore-runtime",
      "title": "Trace runtime behavior",
      "task": "Trace the current runtime path end to end. Return source locations, observed behavior, assumptions, and unresolved risks. Make no changes.",
      "kind": "research",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result identifies the actual runtime path with source-backed evidence and explicit uncertainty.",
      "route": "auto"
    },
    {
      "id": "explore-data",
      "title": "Trace data and persistence",
      "task": "Trace data ownership, persistence, replay, and migration behavior. Return source locations, invariants, and unresolved risks. Make no changes.",
      "kind": "research",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result identifies persistence and replay invariants with source-backed evidence.",
      "route": "auto"
    },
    {
      "id": "explore-experience",
      "title": "Assess user experience",
      "task": "Assess the user-visible workflow, failure recovery, and discoverability. Return concrete friction points and evidence. Make no changes.",
      "kind": "design-review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result identifies concrete user-visible behavior, risks, and evidence without duplicating the other scopes.",
      "route": "auto"
    }
  ]
}
```

## Synthesis

After accepting the leaves, build a compact evidence matrix: question, conclusion, evidence strength,
contradictions, and implication. Verify the one claim that most affects the recommendation. Add a
synthesis node only when the leaves cannot be compared within one bounded manager pass.

## Adaptation

Use two leaves when two independent questions are enough. Add a dependency only when a leaf truly
cannot start responsibly before an upstream result is accepted.
