---
activation: explicit-or-autonomous
confirmWhenAutonomous: true
synthesisOwner: manager
synthesisStrategy: source-quality-triangulation
anonymizeContributors: true
preserveDisagreement: true
---

# Research Panel

Use for uncertain, current, niche, or consequential questions where source strategy or model/provider
diversity can reduce blind spots. Do not use for routine documentation lookup or when one
authoritative source directly answers the question.

## Design

- Divide leaves by source strategy, jurisdiction, stakeholder, or falsification question.
- Require primary sources where available and exact links or source locations.
- Ask one leaf to search for disconfirming evidence rather than producing another general summary.
- Keep leaves independent until their results are accepted.

## Example graph

```json
{
  "explanation": "Triangulate the question across authoritative, ecosystem, and disconfirming evidence.",
  "maxConcurrency": 3,
  "nodes": [
    {
      "id": "research-primary",
      "title": "Research primary sources",
      "task": "Answer the question using current primary or official sources. Return claims, dates, links, source quality, and uncertainty.",
      "kind": "research",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "Material claims are tied to current primary sources and dates.",
      "route": "auto"
    },
    {
      "id": "research-practice",
      "title": "Research real-world practice",
      "task": "Investigate credible implementation experience, operational tradeoffs, and counterexamples. Separate observed practice from opinion.",
      "kind": "research",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result identifies credible real-world evidence and labels its limitations.",
      "route": "auto"
    },
    {
      "id": "research-disconfirm",
      "title": "Search for disconfirming evidence",
      "task": "Try to falsify the leading premise. Search for contradictory data, changed guidance, failure cases, and missing definitions.",
      "kind": "research",
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": "The result either finds concrete contradictory evidence or documents a bounded unsuccessful search.",
      "route": "auto"
    }
  ]
}
```

## Synthesis

Rank sources by authority, recency, directness, and independence. Resolve claim-level contradictions;
do not average them. State what is known, inferred, contested, and still unknown. Verify the claim
most likely to change the recommendation.

## Adaptation

Use named routes to obtain provider diversity only when the active roster explicitly offers suitable
routes. Diversity is useful for search variance, but source quality remains the basis for acceptance.
