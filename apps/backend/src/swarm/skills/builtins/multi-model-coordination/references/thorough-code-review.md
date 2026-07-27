---
activation: explicit-or-autonomous
confirmWhenAutonomous: false
synthesisOwner: manager
synthesisStrategy: severity-and-evidence
anonymizeContributors: true
preserveDisagreement: true
---

# Thorough Code Review

Use when the user requests a thorough, multi-angle review or when a broad/high-risk diff has distinct
correctness, security, design, or operational surfaces. Do not use several reviewers for a small,
well-bounded diff that one focused review can cover.

## Design

- Freeze the exact diff, commit, or ref for every reviewer.
- Split by real risk surface and define exclusions to reduce duplicate comments.
- Require line-specific, reproducible findings and severity.
- Reviewers stay read-only. Remediation is a separate accepted outcome.

## Example graph

```json
{
  "explanation": "Review the same frozen change through distinct, evidence-oriented risk lenses.",
  "maxConcurrency": 4,
  "nodes": [
    {
      "id": "review-correctness",
      "title": "Review correctness",
      "task": "Review the exact diff for functional defects, edge cases, state transitions, and contract violations. Exclude style-only concerns.",
      "kind": "review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "Every reported finding has a tight source location, impact, and reproducible failure path.",
      "route": "auto"
    },
    {
      "id": "review-security",
      "title": "Review security boundaries",
      "task": "Review the exact diff for changed trust boundaries, authorization, secret exposure, injection, and unsafe persistence. Exclude generic hardening outside the diff.",
      "kind": "review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "Every finding is reachable through the changed surface and supported by a concrete attack or misuse path.",
      "route": "auto"
    },
    {
      "id": "review-design",
      "title": "Review design and simplicity",
      "task": "Review the exact diff for duplicate authority, leaky abstraction, unnecessary complexity, API inconsistency, and maintainability regressions.",
      "kind": "design-review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "Concerns identify a concrete cost and the smallest viable correction; preferences are excluded.",
      "route": "auto"
    },
    {
      "id": "review-operations",
      "title": "Review runtime and rollout",
      "task": "Review the exact diff for migration, replay, compatibility, observability, recovery, concurrency, and platform risks.",
      "kind": "review",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "Findings name the affected runtime path and focused validation that demonstrates the risk.",
      "route": "auto"
    }
  ]
}
```

## Synthesis

Deduplicate by root cause and evidence. Rank only actionable findings by severity and confidence.
Resolve conflicting findings with a focused reproduction or source check. Report no finding when a
reviewer offers only preference, possibility, or unrelated hardening.

## Adaptation

Use only the lenses the diff actually exposes. Two focused reviewers are preferable to four
ceremonial reviewers. If fixes are authorized, create remediation nodes after findings are accepted
rather than letting reviewers mutate the shared worktree.
